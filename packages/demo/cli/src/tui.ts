import process from "node:process";
import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { defaultProviders, FileCredentialStore, getProvider } from "@june/ai";
import type { AuthInteraction, AuthPrompt } from "@june/ai";
import { toolResultText } from "@june/core";
import type { AgentHarness, Entry, SqliteSessionRepo } from "@june/core";
import type { RunFlags } from "./run.ts";
import { openHarness, resolveRuntime } from "./run.ts";
import type { ResolvedRuntime } from "./run.ts";

const COLORS = {
  dim: "#8b949e",
  user: "#7aa2f7",
  tool: "#e0af68",
  error: "#f7768e",
  ok: "#9ece6a",
};

interface Ui {
  renderer: CliRenderer;
  header: TextRenderable;
  transcript: ScrollBoxRenderable;
  inputBox: BoxRenderable;
  input: InputRenderable;
  hints: TextRenderable;
  nextId: () => string;
}

function buildUi(renderer: CliRenderer): Ui {
  let counter = 0;
  const nextId = (): string => `n${String(counter++)}`;

  const root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const header = new TextRenderable(renderer, {
    id: "header",
    content: " june",
    fg: COLORS.dim,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    stickyScroll: true,
    paddingLeft: 1,
    paddingRight: 1,
  });

  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    border: true,
    borderStyle: "single",
    height: 3,
  });
  const input = new InputRenderable(renderer, {
    id: "input",
    placeholder: "type a message…",
  });
  inputBox.add(input);

  const hints = new TextRenderable(renderer, {
    id: "hints",
    content: " enter send · esc abort · /tree · /search · ctrl+c quit",
    fg: COLORS.dim,
  });

  root.add(header);
  root.add(transcript);
  root.add(inputBox);
  root.add(hints);
  renderer.root.add(root);
  input.focus();

  return { renderer, header, transcript, inputBox, input, hints, nextId };
}

function appendText(ui: Ui, content: string, fg?: string): void {
  ui.transcript.add(new TextRenderable(ui.renderer, { id: ui.nextId(), content, fg }));
}

function createTuiInteraction(ui: Ui, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt(prompt: AuthPrompt): Promise<string> {
      const promptSignal =
        prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      if (prompt.type === "select") {
        return new Promise<string>((resolve, reject) => {
          appendText(ui, prompt.message);
          const select = new SelectRenderable(ui.renderer, {
            id: ui.nextId(),
            height: Math.min(prompt.options.length * 2, 8),
            options: prompt.options.map((option) => ({
              name: option.label,
              description: option.description ?? "",
              value: option.id,
            })),
          });
          const cleanup = (): void => {
            ui.transcript.remove(select);
            ui.input.focus();
          };
          promptSignal.addEventListener(
            "abort",
            () => {
              cleanup();
              reject(new Error("Login cancelled"));
            },
            { once: true },
          );
          select.on(SelectRenderableEvents.ITEM_SELECTED, (...args: unknown[]) => {
            const option = args[1] as { value?: unknown } | undefined;
            const index = typeof args[0] === "number" ? args[0] : 0;
            const value =
              typeof option?.value === "string" ? option.value : prompt.options[index]?.id;
            cleanup();
            if (value === undefined) reject(new Error("Invalid selection"));
            else {
              appendText(ui, `  → ${value}`, COLORS.dim);
              resolve(value);
            }
          });
          ui.transcript.add(select);
          select.focus();
        });
      }
      return new Promise<string>((resolve, reject) => {
        appendText(ui, prompt.message);
        ui.input.placeholder = prompt.placeholder ?? "";
        const previousTitle = ui.inputBox.title;
        ui.inputBox.title = prompt.type === "secret" ? "secret" : "login";
        const finish = (): void => {
          ui.input.placeholder = "type a message…";
          ui.inputBox.title = previousTitle;
          ui.input.off(InputRenderableEvents.ENTER, onEnter);
        };
        const onEnter = (): void => {
          const value = ui.input.value;
          ui.input.value = "";
          finish();
          appendText(ui, prompt.type === "secret" ? "  → ●●●" : `  → ${value}`, COLORS.dim);
          resolve(value);
        };
        promptSignal.addEventListener(
          "abort",
          () => {
            finish();
            reject(new Error("Login cancelled"));
          },
          { once: true },
        );
        ui.input.on(InputRenderableEvents.ENTER, onEnter);
        ui.input.focus();
      });
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          appendText(ui, event.instructions ?? "Open this URL to continue:");
          appendText(ui, `  ${event.url}`, COLORS.user);
          break;
        case "device_code":
          appendText(ui, `Visit ${event.verificationUri}`, COLORS.user);
          appendText(ui, `Enter code: ${event.userCode}`, COLORS.ok);
          break;
        case "info":
        case "progress":
          appendText(ui, event.message, COLORS.dim);
          break;
      }
    },
  };
}

async function loginViaTui(ui: Ui, flags: RunFlags): Promise<ResolvedRuntime | undefined> {
  const providers = defaultProviders();
  const store = new FileCredentialStore();
  const provider = getProvider(providers, flags.provider ?? "openai-codex");
  const controller = new AbortController();
  const interaction = createTuiInteraction(ui, controller.signal);
  appendText(ui, `No credentials for ${provider.name} — let's log in.`, COLORS.tool);
  const { oauth, apiKey } = provider.auth;
  let mode: "oauth" | "api_key" = oauth !== undefined ? "oauth" : "api_key";
  if (oauth !== undefined && apiKey?.login !== undefined) {
    const picked = await interaction.prompt({
      type: "select",
      message: `Select ${provider.name} login mode:`,
      options: [
        { id: "oauth", label: oauth.name },
        { id: "api_key", label: apiKey.name },
      ],
    });
    mode = picked as "oauth" | "api_key";
  }
  const normalized = { ...interaction, signal: controller.signal };
  const credential =
    mode === "oauth" && oauth !== undefined
      ? await oauth.login(normalized)
      : await apiKey?.login?.(normalized);
  if (credential === undefined) return undefined;
  await store.modify(provider.id, () => Promise.resolve(credential));
  appendText(ui, `Logged in to ${provider.name}.`, COLORS.ok);
  return resolveRuntime(flags);
}

function entryLabel(entry: Entry): string {
  if (entry.type !== "message") return entry.type;
  const { message } = entry;
  const role = message.role ?? message.type ?? "item";
  const partsText = (parts: { type: string; text?: string }[]): string =>
    parts.map((part) => part.text ?? (part.type === "image" ? "[image]" : "")).join("");
  const content = message.content ?? message.output;
  const text =
    typeof content === "string" ? content : Array.isArray(content) ? partsText(content) : "";
  const line = String(text).replaceAll("\n", " ").trim();
  return `${role}: ${line.length > 56 ? `${line.slice(0, 56)}…` : line}`;
}

function renderTree(ui: Ui, entries: Entry[], leafId: string | null): void {
  if (entries.length === 0) {
    appendText(ui, "  (no entries yet)", COLORS.dim);
    return;
  }
  const children = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  const walk = (parentId: string | null, depth: number): void => {
    for (const entry of children.get(parentId) ?? []) {
      const onBranch = entry.id === leafId;
      appendText(
        ui,
        `${"  ".repeat(depth + 1)}${onBranch ? "●" : "○"} ${entry.id}  ${entryLabel(entry)}`,
        onBranch ? COLORS.ok : COLORS.dim,
      );
      walk(entry.id, depth + 1);
    }
  };
  walk(null, 0);
}

async function runCommand(
  ui: Ui,
  harness: AgentHarness,
  repo: SqliteSessionRepo,
  text: string,
): Promise<void> {
  const [command = "", ...rest] = text.slice(1).split(/\s+/);
  const argument = rest.join(" ");
  const session = harness.session;

  if (command === "tree") {
    if (argument === "") {
      renderTree(ui, await session.findEntries(), await session.getLeafId("main"));
      appendText(ui, "  /tree <entry-id> to fork there · /tree root to start over", COLORS.dim);
      return;
    }
    const target = argument === "root" ? null : argument;
    await session.moveLane("main", target);
    appendText(ui, `moved to ${target ?? "root"}; the next message starts a branch`, COLORS.ok);
    return;
  }

  if (command === "search") {
    const hits = await repo.searchEntries(argument, { limit: 10 });
    if (hits.length === 0) appendText(ui, "  no matches", COLORS.dim);
    for (const hit of hits) {
      appendText(ui, `  ${hit.entryId}  ${hit.snippet.replaceAll("\n", " ")}`, COLORS.dim);
    }
    return;
  }

  appendText(ui, `unknown command: /${command} (try /tree or /search)`, COLORS.error);
}

function wireHarness(ui: Ui, harness: AgentHarness, providerLabel: string): void {
  let streamingText: TextRenderable | undefined;
  let reasoningLine: TextRenderable | undefined;
  let streamingBuffer = "";

  const setHeader = (state: string): void => {
    ui.header.content = ` june · ${providerLabel} · ${state}`;
  };
  setHeader("idle");

  harness.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        setHeader("working…");
        break;
      case "turn_start":
        streamingText = undefined;
        reasoningLine = undefined;
        streamingBuffer = "";
        break;
      case "message_update":
        if (event.delta.kind === "reasoning") {
          if (reasoningLine === undefined) {
            reasoningLine = new TextRenderable(ui.renderer, {
              id: ui.nextId(),
              content: "· thinking…",
              fg: COLORS.dim,
            });
            ui.transcript.add(reasoningLine);
          }
        } else {
          if (streamingText === undefined) {
            streamingText = new TextRenderable(ui.renderer, { id: ui.nextId(), content: "" });
            ui.transcript.add(streamingText);
          }
          streamingBuffer += event.delta.text;
          streamingText.content = streamingBuffer;
        }
        break;
      case "message_end": {
        const item = event.message;
        if (item.type === "message" && streamingText !== undefined) {
          streamingText = undefined;
          streamingBuffer = "";
        }
        break;
      }
      case "tool_execution_start": {
        const args = event.args as { command?: string } | undefined;
        const line =
          event.toolName === "bash" && typeof args?.command === "string"
            ? `$ ${args.command}`
            : `⚒ ${event.toolName} ${JSON.stringify(event.args ?? {})}`;
        appendText(ui, line, COLORS.tool);
        setHeader(`running ${event.toolName}…`);
        break;
      }
      case "tool_execution_end": {
        const lines = toolResultText(event.result.content).split("\n");
        const preview = lines.slice(0, 4).join("\n");
        const rest = lines.length > 4 ? `\n… (${String(lines.length - 4)} more lines)` : "";
        appendText(ui, preview + rest, event.isError ? COLORS.error : COLORS.dim);
        setHeader("working…");
        break;
      }
      case "turn_end":
        if (event.message.errorMessage !== undefined) {
          appendText(ui, `error: ${event.message.errorMessage}`, COLORS.error);
        }
        break;
      case "agent_end":
        setHeader("idle");
        break;
    }
  });
}

export async function runTui(flags: RunFlags): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const ui = buildUi(renderer);

  let runtime = await resolveRuntime(flags);
  if (runtime === undefined) {
    runtime = await loginViaTui(ui, flags);
  }
  if (runtime === undefined) {
    renderer.destroy();
    throw new Error("login failed");
  }

  const { harness, suspended, sessionId, repo } = await openHarness(runtime, flags);
  const model = harness.state.model ?? runtime.provider.defaultModel;
  wireHarness(ui, harness, `${runtime.provider.id}/${model}`);
  appendText(ui, `session ${sessionId} · ${runtime.provider.id}/${model}`, COLORS.dim);
  if (suspended.length > 0) {
    appendText(ui, "resuming suspended run…", COLORS.tool);
    void harness.resume();
  }

  ui.input.on(InputRenderableEvents.ENTER, () => {
    const text = ui.input.value.trim();
    if (text === "") return;
    ui.input.value = "";
    appendText(ui, `> ${text}`, COLORS.user);
    if (text.startsWith("/")) {
      void runCommand(ui, harness, repo, text).catch((error: unknown) => {
        appendText(
          ui,
          `error: ${error instanceof Error ? error.message : String(error)}`,
          COLORS.error,
        );
      });
    } else if (harness.state.isStreaming) {
      void harness.steer({ role: "user", content: text });
      appendText(ui, "(queued as steering message)", COLORS.dim);
    } else {
      void harness.prompt(text);
    }
  });

  let lastCtrlC = 0;
  renderer.keyInput.on("keypress", (key: { name: string; ctrl: boolean }) => {
    if (key.name === "escape") {
      void harness.abort();
    } else if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (harness.state.isStreaming && now - lastCtrlC > 1500) {
        lastCtrlC = now;
        void harness.abort();
        appendText(ui, "(aborted — ctrl+c again to quit)", COLORS.dim);
        return;
      }
      void harness
        .close()
        .then(() => repo.close())
        .finally(() => {
          renderer.destroy();
          process.exit(0);
        });
    }
  });

  await new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });
}
