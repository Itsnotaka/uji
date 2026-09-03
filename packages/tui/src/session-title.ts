/**
 * Based on OpenCode v2's session-title generation, title-agent prompt, and
 * small-model selection:
 * https://github.com/anomalyco/opencode/blob/e70d667a9fe3e84cc071a5596aa522c142c525b7/packages/core/src/session/title.ts
 * https://github.com/anomalyco/opencode/blob/e70d667a9fe3e84cc071a5596aa522c142c525b7/packages/core/src/session/context.ts
 * https://github.com/anomalyco/opencode/blob/e70d667a9fe3e84cc071a5596aa522c142c525b7/packages/core/src/plugin/agent.ts
 */
import { contentText } from "@uji-ai/ai";
import type { Api, Model, Models, ThinkingLevel } from "@uji-ai/ai";
import type { JsonValue, Message } from "@uji-ai/schema";
import { buildContextEntries, type Entry, type SessionStorage } from "@uji-ai/core/store";

const HEAD = "main";
const MAX_LENGTH = 100;
const MAX_CONTEXT_LENGTH = 8_000;
const MAX_FIRST_MESSAGE_LENGTH = 2_000;
const TITLE_REASONING: ThinkingLevel = "minimal";

const DEFAULT_TITLE_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`;

/**
 * OpenCode's small-model family priority (gpt-luna, gemini-flash-lite,
 * gemini-flash, claude-haiku), matched on catalog ids because Uji models carry
 * no family field.
 */
const SMALL_MODEL_PRIORITY: readonly ((id: string) => boolean)[] = [
  (id) => id.includes("luna"),
  (id) => id.includes("gemini") && id.includes("flash-lite"),
  (id) => id.includes("gemini") && id.includes("flash"),
  (id) => id.includes("haiku"),
];

export type TitleModels = Pick<Models, "completeSimple" | "getModels">;

export type TitleSession = Pick<
  SessionStorage,
  "getBranch" | "getMetadata" | "getName" | "setNameIfCurrent"
>;

interface ChatNamerDeps {
  /** Read together with the session so a host switch cannot retarget queued work. */
  readonly runtime: () => { readonly models: TitleModels; readonly primary: Model<Api> };
  readonly session: () => TitleSession;
  readonly options?: JsonValue;
}

interface FirstUser {
  readonly id: string;
  readonly text: string;
}

interface TitleSnapshot {
  readonly branch: readonly Entry[];
  readonly expectedName: string | undefined;
  readonly firstUser: FirstUser;
  readonly sessionId: string;
}

type GenerateKind = "automatic" | "explicit";

function titlePrompt(options: JsonValue | undefined): string {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return DEFAULT_TITLE_PROMPT;
  }
  const prompt = options["prompt"];
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : DEFAULT_TITLE_PROMPT;
}

function firstUser(branch: readonly Entry[]): FirstUser | undefined {
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    return { id: entry.id, text: contentText(entry.message.content) };
  }
  return undefined;
}

async function readSnapshot(session: TitleSession): Promise<TitleSnapshot | undefined> {
  const [branch, expectedName, metadata] = await Promise.all([
    session.getBranch(HEAD),
    session.getName(),
    session.getMetadata(),
  ]);
  const first = firstUser(branch);
  return first === undefined
    ? undefined
    : { branch, expectedName, firstUser: first, sessionId: metadata.id };
}

function assistantText(message: Extract<Message, { role: "assistant" }>): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n");
}

function regenerationText(snapshot: TitleSnapshot): string {
  const original = `Original request:\n${snapshot.firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)}`;
  const recent = buildContextEntries(snapshot.branch)
    .flatMap((entry) => {
      if (entry.type !== "message") return [];
      if (entry.message.role === "user" && entry.id !== snapshot.firstUser.id) {
        return [`User: ${contentText(entry.message.content).trim()}`];
      }
      if (entry.message.role !== "assistant") return [];
      const text = assistantText(entry.message);
      return text === "" ? [] : [`Assistant: ${text}`];
    })
    .join("\n\n");
  if (recent === "") return original;
  const prefix = `${original}\n\nRecent conversation:\n`;
  return `${prefix}${recent.slice(-(MAX_CONTEXT_LENGTH - prefix.length))}`;
}

function selectSmallModel(models: TitleModels, primary: Model<Api>): Model<Api> | undefined {
  const candidates = models.getModels(primary.provider);
  for (const matches of SMALL_MODEL_PRIORITY) {
    const selected = candidates.find((model) => matches(model.id));
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function truncate(value: string): string {
  return value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`;
}

async function attempt({
  model,
  models,
  prompt,
  sessionId,
  signal,
  text,
}: {
  readonly model: Model<Api>;
  readonly models: TitleModels;
  readonly prompt: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly text: string;
}): Promise<string | undefined> {
  try {
    const reply = await models.completeSimple(
      model,
      {
        systemPrompt: prompt,
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      },
      { reasoning: TITLE_REASONING, sessionId, signal },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
    return contentText(reply.content)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

async function generate({
  kind,
  models,
  primary,
  prompt,
  session,
  signal,
}: {
  readonly kind: GenerateKind;
  readonly models: TitleModels;
  readonly primary: Model<Api>;
  readonly prompt: string;
  readonly session: TitleSession;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const snapshot = await readSnapshot(session);
  if (snapshot === undefined) return undefined;
  if (kind === "automatic" && snapshot.expectedName !== undefined) return undefined;

  const text =
    snapshot.expectedName === undefined ? snapshot.firstUser.text : regenerationText(snapshot);
  // The provider's small model first, then one retry on the chat model.
  const preferred = selectSmallModel(models, primary);
  const candidates =
    preferred === undefined || preferred.id === primary.id ? [primary] : [preferred, primary];
  let title: string | undefined;
  for (const model of candidates) {
    if (signal.aborted) break;
    title = await attempt({ model, models, prompt, sessionId: snapshot.sessionId, signal, text });
    if (title !== undefined) break;
  }
  if (title === undefined) return undefined;

  const next = truncate(title);
  if (next === snapshot.expectedName) return undefined;
  return (await session.setNameIfCurrent(snapshot.expectedName, next)) ? next : undefined;
}

export interface ChatNamer {
  /** Try the first request only while this session has no name. */
  onUserMessage(): void;
  /** Regenerate now, using recent conversation when the session already has a name. */
  nameNow(): Promise<string | undefined>;
  dispose(): void;
}

export function createChatNamer(deps: ChatNamerDeps): ChatNamer {
  const prompt = titlePrompt(deps.options);
  const disposed = new AbortController();
  const automatic = new WeakSet<TitleSession>();

  return {
    onUserMessage() {
      if (disposed.signal.aborted) return;
      const session = deps.session();
      if (automatic.has(session)) return;
      const { models, primary } = deps.runtime();
      automatic.add(session);
      void generate({
        kind: "automatic",
        models,
        primary,
        prompt,
        session,
        signal: disposed.signal,
      })
        .catch(() => undefined)
        .finally(() => automatic.delete(session));
    },
    nameNow() {
      const session = deps.session();
      const { models, primary } = deps.runtime();
      return generate({
        kind: "explicit",
        models,
        primary,
        prompt,
        session,
        signal: disposed.signal,
      });
    },
    dispose() {
      disposed.abort();
    },
  };
}
