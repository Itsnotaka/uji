import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import type { CliRenderer, KeyEvent, SelectOption } from "@opentui/core";
import type { AuthInteraction, AuthPrompt, Models, Provider } from "@june/ai";
import { newId, toolResultText } from "@june/core";
import type { AgentHarness, Entry, SqliteSessionRepo } from "@june/core";
import { createCliModels, defaultModel, requireModel, requireProvider } from "./catalog.ts";
import {
  displayDelta,
  parseSlashCommand,
  partsText,
  shortId,
  transcriptFromEntries,
} from "./format.ts";
import type { PowerlineState } from "./format.ts";
import { powerlineStyled } from "./powerline.ts";
import type { RunFlags } from "./run.ts";
import { createHarness, openHarness, resolveRuntime } from "./run.ts";
import type { ResolvedRuntime } from "./run.ts";
import { SlashAutocomplete } from "./slash-autocomplete.ts";
import { resolveSlashCommand, SLASH_COMMANDS } from "./slash.ts";
import {
  appendAuthUrl,
  appendNote,
  appendUser,
  AssistantBlock,
  createSyntaxStyle,
  renderItems,
  ThinkingBlock,
  ToolCard,
} from "./transcript.ts";
import type { Transcript } from "./transcript.ts";
import { createTheme } from "./theme.ts";
import type { CliTheme } from "./theme.ts";
import { readWorkspaceStatus } from "./workspace.ts";

interface Ui {
  renderer: CliRenderer;
  root: BoxRenderable;
  transcript: Transcript;
  scroll: ScrollBoxRenderable;
  inputBox: BoxRenderable;
  prompt: TextRenderable;
  input: InputRenderable;
  footer: TextRenderable;
  hints: TextRenderable;
  nextId: (prefix?: string) => string;
  inputMode: "chat" | "auth";
  selecting: boolean;
  authenticating: boolean;
}

export function buildUi(renderer: CliRenderer, theme: CliTheme): Ui {
  let counter = 0;
  const nextId = (prefix = "n"): string => `${prefix}-${String(counter++)}`;

  const root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollX: false,
    scrollY: true,
    paddingLeft: 1,
    paddingRight: 1,
  });

  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    flexDirection: "row",
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.promptBorder,
    focusedBorderColor: theme.promptBorderFocused,
    focusable: true,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = new TextRenderable(renderer, {
    id: "input-prompt",
    content: "> ",
    fg: theme.user,
    height: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    placeholder: "type a message…",
    placeholderColor: theme.dim,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: theme.foreground,
    focusedTextColor: theme.foreground,
    cursorColor: theme.user,
  });
  inputBox.add(prompt);
  inputBox.add(input);

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const hints = new TextRenderable(renderer, {
    id: "hints",
    content: " / commands · enter send · esc abort · ctrl+c quit",
    fg: theme.dim,
    wrapMode: "none",
  });

  root.add(scroll);
  root.add(inputBox);
  root.add(footer);
  root.add(hints);
  renderer.root.add(root);
  input.focus();

  const transcript: Transcript = {
    renderer,
    container: scroll,
    syntaxStyle: createSyntaxStyle(theme),
    theme,
    nextId,
  };
  return {
    renderer,
    root,
    transcript,
    scroll,
    inputBox,
    prompt,
    input,
    footer,
    hints,
    nextId,
    inputMode: "chat",
    selecting: false,
    authenticating: false,
  };
}

function note(ui: Ui, text: string, color?: string): void {
  appendNote(ui.transcript, text, color);
}

function resolveDirectory(cwd: string, input: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(cwd, expanded);
}

interface Choice {
  id: string;
  label: string;
  description?: string;
}

class PickerCancelled extends Error {
  constructor() {
    super("Selection cancelled");
  }
}

/**
 * Input and Select configuration follows OpenTUI's official ExampleSelector.
 * https://github.com/anomalyco/opentui/blob/main/packages/examples/src/index.ts
 */
function selectChoice(
  ui: Ui,
  message: string,
  choices: Choice[],
  options: { selectedId?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (ui.selecting) return Promise.reject(new Error("Another menu is already open"));
  ui.selecting = true;

  return new Promise<string>((resolve, reject) => {
    const listHeight = Math.min(Math.max(choices.length * 2, 2), 12);
    const container = new BoxRenderable(ui.renderer, {
      id: ui.nextId("picker"),
      flexDirection: "column",
      height: listHeight + 1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    container.add(
      new TextRenderable(ui.renderer, {
        id: ui.nextId("picker-title"),
        content: message,
        fg: ui.transcript.theme.foreground,
        height: 1,
      }),
    );
    const selectedIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.id === options.selectedId),
    );
    const select = new SelectRenderable(ui.renderer, {
      id: ui.nextId("select"),
      height: listHeight,
      options: choices.map((choice) => ({
        name: choice.label,
        description: choice.description ?? "",
        value: choice.id,
      })),
      selectedIndex,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      focusedTextColor: ui.transcript.theme.foreground,
      selectedBackgroundColor: ui.transcript.theme.selectionBackground,
      textColor: ui.transcript.theme.foreground,
      selectedTextColor: ui.transcript.theme.selectionForeground,
      descriptionColor: ui.transcript.theme.dim,
      selectedDescriptionColor: ui.transcript.theme.selectionForeground,
      showScrollIndicator: choices.length * 2 > listHeight,
      showDescription: true,
      wrapSelection: true,
    });
    container.add(select);

    let settled = false;
    const cleanup = (): boolean => {
      if (settled) return false;
      settled = true;
      ui.selecting = false;
      options.signal?.removeEventListener("abort", onAbort);
      ui.renderer.keyInput.off("keypress", onKeyPress);
      select.off(SelectRenderableEvents.ITEM_SELECTED, onSelected);
      ui.scroll.remove(container);
      container.destroy();
      ui.input.focus();
      return true;
    };
    const cancel = (): void => {
      if (cleanup()) reject(new PickerCancelled());
    };
    const onAbort = (): void => cancel();
    const onKeyPress = (key: KeyEvent): void => {
      if (key.name !== "escape") return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    };
    const onSelected = (index: number, option: SelectOption): void => {
      const value = typeof option.value === "string" ? option.value : choices[index]?.id;
      if (!cleanup()) return;
      if (value === undefined) reject(new Error("Invalid selection"));
      else resolve(value);
    };

    if (options.signal?.aborted === true) {
      cancel();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    ui.renderer.keyInput.on("keypress", onKeyPress);
    select.on(SelectRenderableEvents.ITEM_SELECTED, onSelected);
    ui.scroll.add(container);
    select.focus();
  });
}

function createTuiInteraction(ui: Ui, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt(prompt: AuthPrompt): Promise<string> {
      const promptSignal =
        prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      if (prompt.type === "select") {
        note(ui, prompt.message, ui.transcript.theme.foreground);
        return selectChoice(
          ui,
          "Choose login method",
          prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description,
          })),
          { signal: promptSignal },
        );
      }
      return new Promise<string>((resolve, reject) => {
        note(ui, prompt.message, ui.transcript.theme.foreground);
        ui.input.placeholder = prompt.placeholder ?? "";
        const previousPrompt = ui.prompt.content;
        ui.prompt.content = prompt.type === "secret" ? "key > " : "login > ";
        ui.inputMode = "auth";
        let settled = false;
        const finish = (): void => {
          promptSignal.removeEventListener("abort", onAbort);
          ui.input.placeholder = "type a message…";
          ui.prompt.content = previousPrompt;
          ui.inputMode = "chat";
          ui.input.off(InputRenderableEvents.ENTER, onEnter);
        };
        const onEnter = (): void => {
          if (settled) return;
          settled = true;
          const value = ui.input.value;
          ui.input.value = "";
          finish();
          note(ui, prompt.type === "secret" ? "  → ●●●" : `  → ${value}`);
          resolve(value);
        };
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          finish();
          reject(new Error("Login cancelled"));
        };
        if (promptSignal.aborted) {
          onAbort();
          return;
        }
        promptSignal.addEventListener("abort", onAbort, { once: true });
        ui.input.on(InputRenderableEvents.ENTER, onEnter);
        ui.input.focus();
      });
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          note(
            ui,
            event.instructions ?? "Open this URL to continue:",
            ui.transcript.theme.foreground,
          );
          appendAuthUrl(ui.transcript, event.url);
          break;
        case "device_code":
          note(ui, `Visit ${event.verificationUri}`, ui.transcript.theme.user);
          note(ui, `Enter code: ${event.userCode}`, ui.transcript.theme.ok);
          break;
        case "info":
        case "progress":
          note(ui, event.message);
          break;
      }
    },
  };
}

async function loginProviderViaTui(
  ui: Ui,
  models: Models,
  provider: Provider,
): Promise<ResolvedRuntime | undefined> {
  const controller = new AbortController();
  const interaction = createTuiInteraction(ui, controller.signal);
  const onKeyPress = (key: { name: string; ctrl: boolean }): void => {
    if (key.ctrl && key.name === "c") controller.abort();
  };
  ui.renderer.keyInput.on("keypress", onKeyPress);
  ui.authenticating = true;
  try {
    note(ui, `Log in to ${provider.name}`, ui.transcript.theme.tool);
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
      if (picked !== "oauth" && picked !== "api_key") {
        throw new Error("Invalid login method");
      }
      mode = picked;
    }
    const normalized = { ...interaction, signal: controller.signal };
    await models.login(provider.id, mode, normalized);
    const auth = await models.getAuth(provider.id);
    if (auth === undefined) return undefined;
    note(ui, `Logged in to ${provider.name}`, ui.transcript.theme.ok);
    return { models, provider: requireProvider(models, provider.id), auth };
  } finally {
    ui.authenticating = false;
    ui.renderer.keyInput.off("keypress", onKeyPress);
  }
}

function entryLabel(entry: Entry): string {
  if (entry.type !== "message") return entry.type;
  const { message } = entry;
  const text = partsText(message.content);
  const line = text.replaceAll("\n", " ").trim();
  return `${message.role}: ${line.length > 56 ? `${line.slice(0, 56)}…` : line}`;
}

function renderTree(ui: Ui, entries: Entry[], leafId: string | null): void {
  if (entries.length === 0) {
    note(ui, "  (no entries yet)");
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
      note(
        ui,
        `${"  ".repeat(depth + 1)}${onBranch ? "●" : "○"} ${entry.id}  ${entryLabel(entry)}`,
        onBranch ? ui.transcript.theme.ok : ui.transcript.theme.dim,
      );
      walk(entry.id, depth + 1);
    }
  };
  walk(null, 0);
}

interface CommandContext {
  repo: SqliteSessionRepo;
  getHarness: () => AgentHarness;
  getRuntime: () => ResolvedRuntime;
  switchRuntime: (runtime: ResolvedRuntime, model: string) => Promise<void>;
  changeDirectory: (directory: string) => Promise<void>;
}

async function pickProvider(ui: Ui, models: Models, selectedId?: string): Promise<Provider> {
  const providers = models.getProviders();
  const id = await selectChoice(
    ui,
    "Choose provider",
    providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      description: `${provider.id} · default ${defaultModel(models, provider.id).id}`,
    })),
    { selectedId },
  );
  return requireProvider(models, id);
}

async function runtimeForProvider(
  ui: Ui,
  models: Models,
  provider: Provider,
): Promise<ResolvedRuntime | undefined> {
  const auth = await models.getAuth(provider.id);
  if (auth !== undefined) {
    return { models, provider: requireProvider(models, provider.id), auth };
  }
  return loginProviderViaTui(ui, models, provider);
}

async function runCommand(ui: Ui, context: CommandContext, text: string): Promise<void> {
  const parsed = parseSlashCommand(text);
  if (parsed === undefined) {
    note(ui, `invalid command: ${text}`, ui.transcript.theme.error);
    return;
  }
  const commandDefinition = resolveSlashCommand(parsed.name);
  if (commandDefinition === undefined) {
    note(ui, `unknown command: /${parsed.name} (try /help)`, ui.transcript.theme.error);
    return;
  }
  const command = commandDefinition.name;
  const { argument } = parsed;
  const harness = context.getHarness();
  const session = harness.session;

  if (command === "help") {
    note(ui, "Commands", ui.transcript.theme.foreground);
    for (const item of SLASH_COMMANDS) {
      note(ui, `  ${`/${item.name}`.padEnd(11)} ${item.description}`);
    }
    return;
  }

  if (command === "login") {
    const models = context.getRuntime().models;
    const provider =
      argument === ""
        ? await pickProvider(ui, models, context.getRuntime().provider.id)
        : requireProvider(models, argument);
    await loginProviderViaTui(ui, models, provider);
    return;
  }

  if (command === "provider") {
    if (harness.state.isStreaming) {
      throw new Error("Wait for the current response before switching provider");
    }
    const current = context.getRuntime();
    const provider =
      argument === ""
        ? await pickProvider(ui, current.models, current.provider.id)
        : requireProvider(current.models, argument);
    if (provider.id === current.provider.id) {
      note(ui, `Already using ${provider.name}`);
      return;
    }
    const runtime = await runtimeForProvider(ui, current.models, provider);
    if (runtime === undefined) throw new Error(`Couldn't log in to ${provider.name}`);
    await context.switchRuntime(runtime, defaultModel(runtime.models, provider.id).id);
    return;
  }

  if (command === "model") {
    if (harness.state.isStreaming) {
      throw new Error("Wait for the current response before switching model");
    }
    const runtime = context.getRuntime();
    const currentModel = harness.state.model.id;
    const providerModels = runtime.models.getModels(runtime.provider.id);
    const modelId =
      argument === ""
        ? await selectChoice(
            ui,
            `Choose ${runtime.provider.name} model`,
            providerModels.map((model) => ({
              id: model.id,
              label: model.name ?? model.id,
              description: model.id,
            })),
            { selectedId: currentModel },
          )
        : argument;
    requireModel(runtime.models, runtime.provider.id, modelId);
    if (modelId === currentModel) {
      note(ui, `Already using ${modelId}`);
      return;
    }
    await context.switchRuntime(runtime, modelId);
    return;
  }

  if (command === "cd") {
    if (argument === "") {
      note(ui, "usage: /cd <directory>", ui.transcript.theme.error);
      return;
    }
    await context.changeDirectory(argument);
    return;
  }

  if (command === "tree") {
    if (argument === "") {
      renderTree(ui, await session.findEntries(), await session.getLeafId("main"));
      note(ui, "  /tree <entry-id> to fork there · /tree root to start over");
      return;
    }
    const target = argument === "root" ? null : argument;
    await session.moveLane("main", target);
    note(
      ui,
      `moved to ${target ?? "root"}; the next message starts a branch`,
      ui.transcript.theme.ok,
    );
    return;
  }

  if (command === "search") {
    if (argument === "") {
      note(ui, "usage: /search <query>", ui.transcript.theme.error);
      return;
    }
    const hits = await context.repo.searchEntries(argument, { limit: 10 });
    if (hits.length === 0) note(ui, "  no matches");
    for (const hit of hits) {
      note(ui, `  ${hit.entryId}  ${hit.snippet.replaceAll("\n", " ")}`);
    }
    return;
  }
}

/** Footer state owner: mutate through `set`, the row re-renders each time. */
class Footer {
  private readonly text: TextRenderable;
  private readonly state: PowerlineState;
  private readonly theme: CliTheme;

  constructor(text: TextRenderable, initial: PowerlineState, theme: CliTheme) {
    this.text = text;
    this.state = initial;
    this.theme = theme;
    this.render();
  }

  set(patch: Partial<PowerlineState>): void {
    Object.assign(this.state, patch);
    this.render();
  }

  get queued(): number {
    return this.state.queued;
  }

  private render(): void {
    this.text.content = powerlineStyled(this.state, this.theme);
  }
}

function wireHarness(ui: Ui, harness: AgentHarness, footer: Footer, cwd: string): () => void {
  let assistant: AssistantBlock | undefined;
  let thinking: ThinkingBlock | undefined;
  const cards = new Map<string, ToolCard>();

  const refreshWorkspace = (): void => {
    void readWorkspaceStatus(cwd).then((status) => {
      footer.set({ workspace: status.name, branch: status.branch, dirty: status.dirty });
    });
  };

  return harness.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        footer.set({ runState: "working", toolName: undefined });
        break;
      case "turn_start":
        assistant = undefined;
        thinking = undefined;
        break;
      case "message_start":
        if (event.message.role === "user") {
          appendUser(ui.transcript, partsText(event.message.content));
          if (footer.queued > 0) footer.set({ queued: footer.queued - 1 });
        }
        break;
      case "message_update":
        const delta = displayDelta(event);
        if (delta?.kind === "reasoning") {
          thinking ??= new ThinkingBlock(ui.transcript);
          thinking.append(delta.text);
        } else if (delta?.kind === "text") {
          assistant ??= new AssistantBlock(ui.transcript);
          assistant.append(delta.text);
        }
        break;
      case "message_end":
        if (event.message.role === "assistant" && assistant !== undefined) {
          assistant.finish();
          assistant = undefined;
        }
        break;
      case "tool_execution_start":
        cards.set(event.toolCallId, new ToolCard(ui.transcript, event.toolName, event.args));
        footer.set({ runState: "running tool", toolName: event.toolName });
        break;
      case "tool_execution_update":
        cards.get(event.toolCallId)?.update(toolResultText(event.partialResult.content));
        break;
      case "tool_execution_end": {
        const card =
          cards.get(event.toolCallId) ?? new ToolCard(ui.transcript, event.toolName, undefined);
        cards.delete(event.toolCallId);
        card.complete(toolResultText(event.result.content), {
          isError: event.isError,
          details: event.result.details,
        });
        footer.set({ runState: "working", toolName: undefined });
        break;
      }
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage !== undefined) {
          note(ui, `error: ${event.message.errorMessage}`, ui.transcript.theme.error);
        }
        break;
      case "agent_end":
        assistant?.finish();
        assistant = undefined;
        footer.set({ runState: "idle", toolName: undefined, queued: 0 });
        refreshWorkspace();
        break;
    }
  });
}

export async function runTui(flags: RunFlags): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const themeMode = renderer.themeMode ?? (await renderer.waitForThemeMode(150));
  const ui = buildUi(renderer, createTheme(themeMode));
  let cwd = process.cwd();

  try {
    let resolvedRuntime = await resolveRuntime(flags);
    if (resolvedRuntime === undefined) {
      const models = createCliModels();
      const provider = requireProvider(models, flags.provider ?? "openai-codex");
      resolvedRuntime = await loginProviderViaTui(ui, models, provider);
    }
    if (resolvedRuntime === undefined) throw new Error("login failed");
    let runtime: ResolvedRuntime = resolvedRuntime;

    const opened = await openHarness(runtime, flags);
    let harness = opened.harness;
    const { suspended, sessionId, repo } = opened;
    const model = harness.state.model.id;
    const workspace = await readWorkspaceStatus(cwd);
    const footer = new Footer(
      ui.footer,
      {
        runState: "idle",
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
        provider: runtime.provider.id,
        model,
        effort: harness.state.thinkingLevel,
        session: (await harness.session.getName()) ?? shortId(sessionId),
        queued: 0,
      },
      ui.transcript.theme,
    );
    let unsubscribeHarness = wireHarness(ui, harness, footer, cwd);

    const switchRuntime = async (
      nextRuntime: ResolvedRuntime,
      nextModel: string,
    ): Promise<void> => {
      if (harness.state.isStreaming) {
        throw new Error("Wait for the current response before switching runtime");
      }
      const previousHarness = harness;
      const previousProvider = runtime.provider.id;
      const previousModel = harness.state.model.id;
      const effort = harness.state.thinkingLevel;
      const session = harness.session;

      if (previousProvider !== nextRuntime.provider.id) {
        await session.appendEntry(
          {
            type: "custom",
            id: newId("e"),
            customType: "provider_change",
            data: { providerId: nextRuntime.provider.id },
          },
          "main",
        );
      }
      if (previousModel !== nextModel) {
        await session.appendEntry(
          { type: "model_change", id: newId("e"), modelId: nextModel },
          "main",
        );
      }

      const next = await createHarness(nextRuntime, session, sessionId, {
        model: nextModel,
        effort,
        cwd,
      });
      unsubscribeHarness();
      harness = next.harness;
      runtime = nextRuntime;
      unsubscribeHarness = wireHarness(ui, harness, footer, cwd);
      await previousHarness.close();
      footer.set({
        provider: runtime.provider.id,
        model: nextModel,
        effort: harness.state.thinkingLevel,
      });
      note(ui, `Using ${runtime.provider.name} · ${nextModel}`, ui.transcript.theme.ok);
    };

    const changeDirectory = async (input: string): Promise<void> => {
      if (harness.state.isStreaming) {
        throw new Error("Wait for the current response before changing directory");
      }
      const nextCwd = resolveDirectory(cwd, input);
      const info = await stat(nextCwd);
      if (!info.isDirectory()) throw new Error(`Not a directory: ${nextCwd}`);
      if (nextCwd === cwd) {
        note(ui, `Already in ${nextCwd}`);
        return;
      }

      const previousHarness = harness;
      const session = harness.session;
      const next = await createHarness(runtime, session, sessionId, {
        model: harness.state.model.id,
        effort: harness.state.thinkingLevel,
        cwd: nextCwd,
      });
      try {
        await session.appendEntry(
          {
            type: "custom",
            id: newId("e"),
            customType: "cwd_change",
            data: { cwd: nextCwd },
          },
          "main",
        );
        process.chdir(nextCwd);
      } catch (error) {
        await next.harness.close().catch(() => undefined);
        throw error;
      }

      unsubscribeHarness();
      harness = next.harness;
      cwd = nextCwd;
      unsubscribeHarness = wireHarness(ui, harness, footer, cwd);
      await previousHarness.close();
      const workspace = await readWorkspaceStatus(cwd);
      footer.set({
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
      });
      note(ui, `Working directory: ${cwd}`, ui.transcript.theme.ok);
    };

    const commandContext: CommandContext = {
      repo,
      getHarness: () => harness,
      getRuntime: () => runtime,
      switchRuntime,
      changeDirectory,
    };

    const reportCommandError = (error: unknown): void => {
      if (error instanceof PickerCancelled) return;
      note(
        ui,
        `error: ${error instanceof Error ? error.message : String(error)}`,
        ui.transcript.theme.error,
      );
    };

    const slashAutocomplete = new SlashAutocomplete({
      renderer,
      input: ui.input,
      theme: ui.transcript.theme,
      nextId: ui.nextId,
      onCommand(command) {
        const text = `/${command.name}`;
        note(ui, `> ${text}`, ui.transcript.theme.user);
        void runCommand(ui, commandContext, text).catch(reportCommandError);
      },
    });
    ui.root.insertBefore(slashAutocomplete.container, ui.inputBox);

    if (flags.resume) {
      const branch = await harness.session.getBranch("main");
      renderItems(ui.transcript, transcriptFromEntries(branch));
      note(ui, `resumed session ${sessionId} · ${String(branch.length)} entries`);
    } else {
      note(ui, `session ${sessionId} · ${runtime.provider.id}/${model}`);
    }
    if (suspended.length > 0) {
      note(ui, "resuming suspended run…", ui.transcript.theme.tool);
      footer.set({ runState: "resuming" });
      void harness.resume();
    }

    ui.input.on(InputRenderableEvents.INPUT, (value: string) => {
      if (ui.inputMode !== "chat" || ui.selecting) {
        slashAutocomplete.close();
        return;
      }
      slashAutocomplete.update(value);
    });

    ui.input.on(InputRenderableEvents.ENTER, () => {
      if (ui.inputMode !== "chat" || ui.selecting) return;
      if (slashAutocomplete.visible) return;
      const text = ui.input.value.trim();
      if (text === "") return;
      ui.input.value = "";
      slashAutocomplete.close();
      if (text.startsWith("/")) {
        note(ui, `> ${text}`, ui.transcript.theme.user);
        void runCommand(ui, commandContext, text).catch(reportCommandError);
      } else if (harness.state.isStreaming) {
        footer.set({ queued: footer.queued + 1 });
        note(ui, `queued for the next turn: ${text}`);
        void harness.steer({ role: "user", content: text, timestamp: Date.now() });
      } else {
        void harness.prompt(text);
      }
    });

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        unsubscribeHarness();
        await harness.close().catch(() => undefined);
        await repo.close().catch(() => undefined);
        renderer.destroy();
      })();
      return shutdownPromise;
    };

    let lastCtrlC = 0;
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (slashAutocomplete.handleKey(key) || key.defaultPrevented) return;
      if (key.name === "escape") {
        if (ui.selecting || ui.inputMode === "auth") return;
        void harness.abort();
      } else if (key.ctrl && key.name === "c") {
        if (ui.authenticating) return;
        const now = Date.now();
        if (harness.state.isStreaming && now - lastCtrlC > 1500) {
          lastCtrlC = now;
          void harness.abort();
          note(ui, "aborted · ctrl+c again to quit");
          return;
        }
        void shutdown();
      }
    });

    await new Promise<void>((resolve) => {
      renderer.on("destroy", () => resolve());
    });
    await shutdown();
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}
