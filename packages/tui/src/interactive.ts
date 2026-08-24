import process from "node:process";
import open from "open";
import { createCliRenderer, decodePasteBytes, RenderableEvents } from "@opentui/core";
import type { KeyEvent, PasteEvent } from "@opentui/core";
import { getSupportedThinkingLevels } from "@uji-ai/ai";
import type { Api, AuthInteraction, AuthPrompt, Model, Models, Provider } from "@uji-ai/ai";
import {
  buildSessionContext,
  calculateContextTokens,
  estimateContextTokens,
  formatSkillInvocation,
  getLastAssistantUsage,
  SKILLS_PLUGIN_ID,
  toolResultText,
  watchPluginDirectories,
  WorkspaceTrustRequired,
} from "@uji-ai/core";
import type {
  AgentHarness,
  Entry,
  HarnessEvent,
  RunOutcome,
  SqliteSessionRepo,
  SuspendedOperation,
  ThinkingLevel,
  TrustedWorkspace,
  WorkspaceTrustStore,
} from "@uji-ai/core";
import type { Usage } from "@uji-ai/schema";
import {
  cachedAuthenticatedModels,
  createCliModels,
  defaultModel,
  loadAuthenticatedModels,
  loadProviderCatalog,
  providerAuthStatuses,
  requireProvider,
} from "./catalog.ts";
import {
  ComposerParts,
  discoverMentionFiles,
  foldAttachments,
  PASTE_COLLAPSE_LINES,
  pasteLineCount,
  PromptHistory,
  resolveComposerImagePaste,
  resolveComposerPaste,
} from "./composer.ts";
import type { ComposerPart, MentionFile } from "./composer.ts";
import { ComposerTags } from "./composer-tags.ts";
import { discoverDirectorySuggestions } from "./directory-autocomplete.ts";
import {
  oneLine,
  parseComposerSubmission,
  partsText,
  shortId,
  providerCacheTtlMs,
} from "./format.ts";
import type { ParsedSlashCommand, PowerlineState } from "./format.ts";
import { HarnessHost } from "./harness-host.ts";
import type { CreateHostedHarness } from "./harness-host.ts";
import { createChatKeymap, registerChatLayer, registerSelectionLayer } from "./keymap.ts";
import {
  createTuiShutdown,
  DoubleEscape,
  escapeIntent,
  isComposerTextKey,
  nextThinkingLevel,
  resumeSessionHint,
  tuiKeyAction,
} from "./lifecycle.ts";
import { editInExternalEditor, resolveExternalEditor } from "./external-editor.ts";
import type { RunFlags } from "./run.ts";
import {
  createHarness,
  openHarness,
  pluginDirectories,
  preferredRunProvider,
  resolveCliPlugins,
  resolveRuntime,
  skillDirectories,
} from "./run.ts";
import type { ResolvedRuntime } from "./run.ts";
import { FileSettingsStore, TRANSPORTS } from "./settings.ts";
import type { ResolvedSettings } from "./settings.ts";
import { createTuiRenderLog, renderLogError } from "./render-log.ts";
import type { TuiRenderLog } from "./render-log.ts";
import { PickerCancelled } from "./picker.ts";
import type { Choice, ChoiceAction, MenuScreen } from "./picker.ts";
import { SlashAutocomplete } from "./slash-autocomplete.ts";
import { watchSessionBranch } from "./session-observer.ts";
import {
  acceptSlashCommand,
  availableSlashCommands,
  resolveSlashCommand,
  skillPaletteItems,
  slashCommandLabel,
} from "./slash.ts";
import type { SlashCommand } from "./slash.ts";
import { appendAuthUrl, appendNote, ConversationTurnBlock, entryNote } from "./transcript.ts";
import { THEME } from "./theme.ts";
import { type Severity, updateSeverity } from "./cli-style.ts";
import { describeUpdateOutcome, selfUpdate } from "./update.ts";
import { checkForUpdate } from "./version.ts";
import {
  AUTH_URL_HINTS,
  BUSY_HINTS,
  BUSY_COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER,
  CTRL_C_EXIT_HINT,
  IDLE_HINTS,
  SCROLLBACK_BUSY_HINTS,
  SCROLLBACK_HINTS,
} from "./constants.ts";
import { readWorkspaceStatus } from "./workspace.ts";
import { createWorkspaceTrustStore, requestWorkspaceTrust } from "./workspace-trust.ts";
import type { WorkspaceTrustDeclineAction } from "./workspace-trust.ts";

import {
  buildUi,
  closeInlineMenu,
  ComposerStatus,
  flash,
  note,
  openInlineMenu,
  replaceTranscript,
  selectChoice,
  setHints,
  setInputText,
  showMenuScreen,
  turnNote,
} from "./tui.ts";
import type { Ui } from "./tui.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshHints(ui: Ui, harness: AgentHarness): void {
  const busy = harness.state.isStreaming || harness.state.isCompacting;
  setHints(
    ui,
    ui.focus.isUsing(ui.scroll)
      ? busy
        ? SCROLLBACK_BUSY_HINTS
        : SCROLLBACK_HINTS
      : busy
        ? BUSY_HINTS
        : IDLE_HINTS,
  );
}

function markEntryRendered(ui: Ui, entryId: string): void {
  if (!ui.renderedEntries.delete(entryId)) ui.renderedEntries.add(entryId);
}

async function answerAsk(
  ui: Ui,
  harness: AgentHarness,
  event: Extract<HarnessEvent, { type: "ask" }>,
): Promise<void> {
  const { request } = event;
  const title =
    request.message === undefined
      ? request.title
      : `${request.title} · ${request.message.split("\n")[0] ?? ""}`;
  try {
    if (request.kind === "confirm") {
      const picked = await selectChoice(ui, title, [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ]);
      harness.answer(event.askId, picked === "yes");
      return;
    }
    if (request.kind === "select") {
      const picked = await selectChoice(
        ui,
        title,
        request.options.map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description,
        })),
        { selectedId: request.default },
      );
      harness.answer(event.askId, picked);
      return;
    }
    const answered = await new Promise<string>((resolve, reject) => {
      turnNote(ui, title, ui.transcript.theme.foreground);
      ui.input.placeholder = request.placeholder ?? "";
      const previousPrompt = ui.prompt.content;
      const previousSubmit = ui.input.onSubmit;
      ui.prompt.content = "input > ";
      ui.inputMode = "auth";
      let settled = false;
      const finish = (): void => {
        ui.renderer.keyInput.off("keypress", onKeyPress);
        ui.input.placeholder =
          harness.state.isStreaming || harness.state.isCompacting
            ? BUSY_COMPOSER_PLACEHOLDER
            : COMPOSER_PLACEHOLDER;
        ui.prompt.content = previousPrompt;
        ui.inputMode = "chat";
        ui.input.onSubmit = previousSubmit;
      };
      const onEnter = (): void => {
        if (settled) return;
        settled = true;
        const text = ui.input.plainText;
        const value = text === "" && request.default !== undefined ? request.default : text;
        ui.input.clear();
        finish();
        turnNote(ui, `→ ${value}`);
        resolve(value);
      };
      const onCancel = (): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(new PickerCancelled());
      };
      const onKeyPress = (key: KeyEvent): void => {
        if (key.name !== "escape") return;
        key.preventDefault();
        key.stopPropagation();
        onCancel();
      };
      ui.renderer.keyInput.on("keypress", onKeyPress);
      ui.input.onSubmit = onEnter;
      ui.input.focus();
    });
    harness.answer(event.askId, answered);
  } catch (error) {
    if (!(error instanceof PickerCancelled)) {
      harness.dismissAsk(event.askId);
      throw error;
    }
    if (request.default !== undefined) harness.answer(event.askId, request.default);
    else harness.dismissAsk(event.askId);
  }
}

export function wireHarness(
  ui: Ui,
  harness: AgentHarness,
  status: ComposerStatus,
  cwd: string,
  isVisible: () => boolean = () => true,
): () => void {
  let queueVersion = 0;

  const ensureTurn = (): ConversationTurnBlock => {
    ui.activeTurn ??= new ConversationTurnBlock(ui.transcript);
    return ui.activeTurn;
  };

  const runNote = (text: string, color?: string): void => {
    turnNote(ui, text, color);
  };

  const refreshWorkspace = (): void => {
    void readWorkspaceStatus(cwd).then((workspace) => {
      if (!isVisible()) return;
      status.set({
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
      });
    });
  };

  const refreshUsage = (usage: Usage): void => {
    void harness.session.getBranch("main").then((branch) => {
      if (!isVisible()) return;
      const tokens = estimateContextTokens(buildSessionContext(branch)).tokens;
      const contextWindow = harness.state.model.contextWindow;
      status.set({
        tokens: calculateContextTokens(usage),
        ...(contextWindow > 0 ? { pct: Math.round((tokens / contextWindow) * 100) } : {}),
      });
    });
  };

  const cacheTtlPatch = (provider: string): Partial<PowerlineState> => {
    const ttl = providerCacheTtlMs(provider);
    return ttl === undefined ? {} : { cacheTtlMs: ttl };
  };
  const unsubscribe = harness.subscribe((event) => {
    if (!isVisible()) return;
    switch (event.type) {
      case "agent_start":
        status.set({ runState: "working" });
        ui.input.placeholder = BUSY_COMPOSER_PLACEHOLDER;
        refreshHints(ui, harness);
        break;
      case "turn_start":
        ui.activeTurn?.nextStep();
        break;
      case "message_start":
        if (event.message.role === "user") {
          ui.activeTurn?.settle();
          ui.activeTurn = new ConversationTurnBlock(ui.transcript);
          ui.activeTurn.addUser(event.message.content);
        }
        break;
      case "message_update":
        ensureTurn().updateAssistant(event.assistantMessageEvent);
        break;
      case "message_end":
        ui.steeringStatus.resolve(event.entryId);
        markEntryRendered(ui, event.entryId);
        if (event.message.role === "assistant") ensureTurn().finishAssistant(event.message);
        if (event.message.role === "toolResult") {
          ensureTurn().finishTool(
            event.message.toolCallId,
            event.message.toolName,
            toolResultText(event.message.content),
            { isError: event.message.isError, details: event.message.details },
          );
        }
        break;
      case "tool_execution_start":
        ui.transcript.cwd = cwd;
        ensureTurn().startTool(event.toolCallId, event.toolName, event.args);
        status.set({ runState: "running tool" });
        break;
      case "tool_execution_update":
        ensureTurn().updateTool(event.toolCallId, toolResultText(event.partialResult.content));
        break;
      case "tool_execution_end":
        ensureTurn().finishTool(
          event.toolCallId,
          event.toolName,
          toolResultText(event.result.content),
          { isError: event.isError, details: event.result.details },
        );
        status.set({ runState: "working" });
        break;
      case "compaction_start":
        status.set({ runState: "compacting" });
        ui.input.placeholder = BUSY_COMPOSER_PLACEHOLDER;
        refreshHints(ui, harness);
        runNote(
          event.reason === "manual" ? "Compacting…" : "Auto-compacting…",
          ui.transcript.theme.tool,
        );
        break;
      case "compaction_end":
        status.set({ runState: harness.state.isStreaming ? "working" : "idle" });
        if (!harness.state.isStreaming) ui.input.placeholder = COMPOSER_PLACEHOLDER;
        if (event.outcome === "completed") {
          markEntryRendered(ui, event.entry.id);
          if (ui.activeTurn === undefined) {
            appendNote(
              ui.transcript,
              `Compacted · ${String(event.entry.tokensBefore)} tokens`,
              ui.transcript.theme.ok,
            );
          } else {
            ui.activeTurn.addCompaction(event.entry.summary, event.entry.tokensBefore);
          }
        } else if (event.outcome === "aborted") {
          runNote("Compaction stopped");
        } else {
          runNote(`Compaction failed: ${event.error.message}`, ui.transcript.theme.error);
        }
        refreshHints(ui, harness);
        break;
      case "turn_end": {
        if (event.message.role !== "assistant") break;
        const { message } = event;
        ensureTurn().finishAssistant(message);
        if (message.stopReason !== "aborted" && message.errorMessage !== undefined) {
          runNote(`Error: ${message.errorMessage}`, ui.transcript.theme.error);
        }
        refreshUsage(message.usage);
        break;
      }
      case "queue_update":
        queueVersion += 1;
        ui.steeringStatus.sync(
          event.items.filter((item) => item.delivery === "steer").map((item) => item.entryId),
        );
        status.set({ queued: event.items.length });
        break;
      case "agent_end":
        ui.activeTurn?.settle();
        ui.activeTurn = undefined;
        status.set({
          runState: "idle",
          stoppedAt: Date.now(),
          ...cacheTtlPatch(harness.state.model.provider),
        });
        ui.input.placeholder = COMPOSER_PLACEHOLDER;
        refreshHints(ui, harness);
        refreshWorkspace();
        break;
      case "handler_error": {
        const owner =
          event.kind === "hook"
            ? `hook ${event.hook}`
            : event.kind === "event"
              ? `listener ${event.event}`
              : `plugin ${event.plugin}`;
        runNote(`${owner}: ${event.error}`, ui.transcript.theme.error);
        break;
      }
      case "diagnostic":
        if (
          event.owner === SKILLS_PLUGIN_ID &&
          event.message.includes(" was ignored; first loaded from ")
        ) {
          break;
        }
        runNote(
          `${event.owner}: ${event.message}`,
          event.level === "error" || event.owner === SKILLS_PLUGIN_ID
            ? ui.transcript.theme.error
            : undefined,
        );
        break;
      case "plugin_updated": {
        const failed = event.plugins.filter((plugin) => plugin.status === "failed");
        runNote(
          `plugins: ${String(event.plugins.length - failed.length)} active${failed.length === 0 ? "" : `, ${String(failed.length)} failed`}`,
          failed.length === 0 ? undefined : ui.transcript.theme.error,
        );
        break;
      }
      case "ask":
        void answerAsk(ui, harness, event).catch((error: unknown) => {
          runNote(
            `ask failed: ${error instanceof Error ? error.message : String(error)}`,
            ui.transcript.theme.error,
          );
        });
        break;
      case "ask_answered":
        if (event.source === "client")
          runNote(`Answered: ${event.answer}`, ui.transcript.theme.dim);
        break;
      case "config_update":
        if (event.property === "settings") {
          void settingStatuses(harness).then((statuses) => {
            if (isVisible()) status.set({ statuses });
          });
        }
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  });
  const snapshotVersion = queueVersion;
  void harness.pendingQueue().then((items) => {
    if (!isVisible() || queueVersion !== snapshotVersion) return;
    ui.steeringStatus.sync(
      items.filter((item) => item.delivery === "steer").map((item) => item.entryId),
    );
    status.set({ queued: items.length });
  });
  return unsubscribe;
}

export function shouldReloadTranscript(
  ui: Ui,
  harness: Pick<AgentHarness, "state">,
  leafId: string | null,
): boolean {
  if (leafId !== null && ui.renderedEntries.delete(leafId)) return false;
  if (leafId !== null && harness.state.isBusy) {
    ui.renderedEntries.add(leafId);
    return false;
  }
  return !harness.state.isBusy;
}

function openAuthUrl(ui: Ui, input: string): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    note(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    note(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
    return;
  }
  void open(url.toString()).catch(() => {
    note(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
  });
}

export function userPromptHistory(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const text = partsText(entry.message.content);
    return text.trim() === "" ? [] : [text];
  });
}

export async function chooseTrustedWorkspace(
  ui: Ui,
  store: WorkspaceTrustStore,
  cwd: string,
  declineAction: WorkspaceTrustDeclineAction,
  signal?: AbortSignal,
  renderLog?: TuiRenderLog,
): Promise<TrustedWorkspace | undefined> {
  const resolution = await store.resolve(cwd);
  if (resolution.kind === "trusted") return resolution.workspace;
  if (ui.selecting) throw new Error("Another menu is already open");

  renderLog?.record({ kind: "workspace_trust_opened", declineAction });
  ui.selecting = true;
  try {
    const decision = await requestWorkspaceTrust({
      renderer: ui.renderer,
      theme: ui.transcript.theme,
      cwd: resolution.cwd,
      declineAction,
      signal,
      nextId: ui.nextId,
    });
    renderLog?.record({ kind: "workspace_trust_resolved", decision, declineAction });
    return decision === "trust" ? await store.trust(resolution.cwd) : undefined;
  } finally {
    ui.selecting = false;
  }
}

function createTuiInteraction(ui: Ui, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt(prompt: AuthPrompt): Promise<string> {
      const promptSignal =
        prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      if (prompt.type === "select") {
        return selectChoice(
          ui,
          "Login method",
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
        const previousSubmit = ui.input.onSubmit;
        ui.prompt.content = prompt.type === "secret" ? "key > " : "login > ";
        ui.inputMode = "auth";
        let settled = false;
        const finish = (): void => {
          promptSignal.removeEventListener("abort", onAbort);
          ui.input.placeholder = COMPOSER_PLACEHOLDER;
          ui.prompt.content = previousPrompt;
          ui.inputMode = "chat";
          ui.input.onSubmit = previousSubmit;
        };
        const onEnter = (): void => {
          if (settled) return;
          settled = true;
          const value = ui.input.plainText;
          ui.input.clear();
          finish();
          note(ui, prompt.type === "secret" ? "→ ●●●" : `→ ${value}`);
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
        ui.input.onSubmit = onEnter;
        ui.input.focus();
      });
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          setHints(ui, AUTH_URL_HINTS);
          note(
            ui,
            event.instructions ?? "Open this URL to continue:",
            ui.transcript.theme.foreground,
          );
          appendAuthUrl(ui.transcript, {
            url: event.url,
            openUrl: (url) => openAuthUrl(ui, url),
          });
          break;
        case "device_code":
          appendAuthUrl(ui.transcript, {
            url: event.verificationUri,
            openUrl: (url) => openAuthUrl(ui, url),
            prefix: "Visit ",
          });
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

export async function loginProviderViaTui(
  ui: Ui,
  models: Models,
  provider: Provider,
): Promise<ResolvedRuntime | undefined> {
  const controller = new AbortController();
  const interaction = createTuiInteraction(ui, controller.signal);
  const previousHints = ui.hintText;
  const onKeyPress = (key: { name: string; ctrl: boolean }): void => {
    if (key.ctrl && key.name === "c") controller.abort();
  };
  ui.renderer.keyInput.on("keypress", onKeyPress);
  ui.authenticating = true;
  try {
    note(ui, `Logging in to ${provider.name}…`, ui.transcript.theme.tool);
    const { oauth, apiKey } = provider.auth;
    let mode: "oauth" | "api_key" = oauth !== undefined ? "oauth" : "api_key";
    if (oauth !== undefined && apiKey?.login !== undefined) {
      const picked = await interaction.prompt({
        type: "select",
        message: `${provider.name} login method`,
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
    await loadProviderCatalog(models, provider.id);
    const auth = await models.getAuth(provider.id);
    if (auth === undefined) return undefined;
    note(ui, `Logged in to ${provider.name}`, ui.transcript.theme.ok);
    return { models, provider: requireProvider(models, provider.id), auth };
  } finally {
    ui.authenticating = false;
    setHints(ui, previousHints);
    ui.renderer.keyInput.off("keypress", onKeyPress);
  }
}

function entryLabel(entry: Entry): string {
  if (entry.type !== "message") return entry.type;
  const { message } = entry;
  const line = oneLine(foldAttachments(partsText(message.content)));
  return `${message.role}: ${line}`;
}

/** Name for the picker, or undefined for a session nothing was ever sent to. */
async function sessionLabel(
  repo: SqliteSessionRepo,
  sessionId: string,
): Promise<string | undefined> {
  const reader = await repo.open(sessionId);
  try {
    if ((await reader.getLeafId("main")) === null) return undefined;
    return (await reader.getName()) ?? shortId(sessionId);
  } finally {
    await reader.close().catch(() => undefined);
  }
}

const TREE_ROOT_ID = "tree:root";

/** The user turns on a branch, oldest first: the only entries that can be edited. */
export function userMessageEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
}

function messageChoices(entries: readonly Entry[]): Choice[] {
  return entries.map((entry, index) => ({
    id: entry.id,
    label: oneLine(
      foldAttachments(entry.type === "message" ? partsText(entry.message.content) : ""),
    ),
    description: `${String(index + 1)} of ${String(entries.length)} \u00b7 ${new Date(entry.timestamp).toLocaleString()}`,
  }));
}

function treeChoices(entries: Entry[]): Choice[] {
  return [
    {
      id: TREE_ROOT_ID,
      label: "Start over",
      description: "Branch from the beginning of this chat",
    },
    ...entries.map((entry) => ({
      id: entry.id,
      label: entryLabel(entry),
      description: `${shortId(entry.id)} · ${new Date(entry.timestamp).toLocaleString()}`,
    })),
  ];
}

type CommandTarget = { sessionId: string; harness: AgentHarness };

export interface CommandContext {
  repo: SqliteSessionRepo;
  getTarget: () => CommandTarget;
  getRuntime: () => ResolvedRuntime;
  getTrustedWorkspace: () => Promise<TrustedWorkspace>;
  switchRuntime: (runtime: ResolvedRuntime, model: string) => Promise<void>;
  changeDirectory: (directory: string) => Promise<void>;
  changeThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  refreshPluginState: () => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  nameSession: (name: string) => Promise<void>;
  openCommandPalette: () => Promise<void>;
  openSettings: () => Promise<void>;
  openSkillPalette: () => Promise<void>;
  /** Move the active head to an entry, or to the start of the chat with `null`. */
  navigateTo: (entryId: string | null) => Promise<void>;
  shutdown: () => Promise<void>;
}

const slashCommandCache = new WeakMap<
  AgentHarness,
  {
    pluginCommands: ReturnType<AgentHarness["getCommands"]>;
    skills: ReturnType<AgentHarness["getResources"]>;
    projected: SlashCommand[];
  }
>();

export function slashCommandsForHarness(harness: AgentHarness): SlashCommand[] {
  const pluginCommands = harness.getCommands();
  const skills = harness.getResources();
  const cached = slashCommandCache.get(harness);
  if (cached?.pluginCommands === pluginCommands && cached.skills === skills) {
    return cached.projected;
  }
  const projected = availableSlashCommands(pluginCommands, skills);
  slashCommandCache.set(harness, { pluginCommands, skills, projected });
  return projected;
}

/** Badges from plugin settings: each setting's current choice contributes its `status`, if any. */
export async function activeSettingBadges(
  harness: AgentHarness,
): Promise<ReadonlyMap<string, { label: string; status: string }>> {
  const badges = new Map<string, { label: string; status: string }>();
  for (const [id, setting] of harness.getSettings()) {
    const current = await setting.read();
    const status = setting.choices.find((choice) => choice.id === current)?.status;
    if (status !== undefined) badges.set(id, { label: setting.label, status });
  }
  return badges;
}

export async function settingStatuses(harness: AgentHarness): Promise<readonly string[]> {
  return [...(await activeSettingBadges(harness)).values()].map((badge) => badge.status);
}

export async function activateLoggedInRuntime({
  currentProviderId,
  runtime,
  switchRuntime,
}: {
  currentProviderId: string;
  runtime: ResolvedRuntime;
  switchRuntime: CommandContext["switchRuntime"];
}): Promise<void> {
  if (runtime.provider.id === currentProviderId) return;
  await switchRuntime(runtime, defaultModel(runtime.models, runtime.provider.id).id);
}

async function pickProvider(ui: Ui, models: Models, selectedId?: string): Promise<Provider> {
  const statuses = await providerAuthStatuses(models);
  const ordered = statuses.toSorted(
    (left, right) => Number(right.kind === "authenticated") - Number(left.kind === "authenticated"),
  );
  const choices: Choice[] = [];
  for (const status of ordered) {
    const { provider } = status;
    const count = models.getModels(provider.id).length;
    const detail =
      count === 0
        ? provider.id
        : `${provider.id} · default ${defaultModel(models, provider.id).id}`;
    const connection =
      status.kind === "authenticated"
        ? `logged in${status.auth.source === undefined ? "" : ` via ${status.auth.source}`}`
        : "not logged in";
    choices.push({
      id: provider.id,
      label: provider.name,
      description: `${detail} · ${connection}`,
    });
  }
  const id = await selectChoice(ui, "Provider", choices, { selectedId });
  return requireProvider(models, id);
}

async function runtimeForProvider(
  ui: Ui,
  models: Models,
  provider: Provider,
): Promise<ResolvedRuntime | undefined> {
  const auth = await models.getAuth(provider.id);
  if (auth !== undefined) {
    await loadProviderCatalog(models, provider.id);
    return { models, provider: requireProvider(models, provider.id), auth };
  }
  return loginProviderViaTui(ui, models, provider);
}

function findModelReference(
  available: readonly Model<Api>[],
  currentProviderId: string,
  reference: string,
): Model<Api> | undefined {
  return (
    available.find((model) => model.provider === currentProviderId && model.id === reference) ??
    available.find((model) => `${model.provider}/${model.id}` === reference)
  );
}

async function runtimeForModel(
  current: ResolvedRuntime,
  model: Model<Api>,
): Promise<ResolvedRuntime> {
  if (model.provider === current.provider.id) return current;
  const provider = requireProvider(current.models, model.provider);
  const auth = await current.models.getAuth(provider.id);
  if (auth === undefined) throw new Error(`${provider.name} is not logged in`);
  return { models: current.models, provider, auth };
}

function modelChoiceId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function modelChoices(models: Models, available: readonly Model<Api>[]): Choice[] {
  return available.map((model) => ({
    id: modelChoiceId(model),
    label: model.name ?? model.id,
    description:
      model.name === undefined || model.name === model.id
        ? requireProvider(models, model.provider).name
        : `${requireProvider(models, model.provider).name} · ${model.id}`,
  }));
}

/** The catalog already in memory, so the model list paints on the same frame. */
function cachedModelChoices(models: Models): Choice[] {
  return modelChoices(models, cachedAuthenticatedModels(models) ?? []);
}

async function reloadModelChoices(models: Models): Promise<Choice[]> {
  return modelChoices(models, await loadAuthenticatedModels(models, { force: true }));
}

async function switchToModelChoice(
  runtime: ResolvedRuntime,
  choiceId: string,
  switchRuntime: (next: ResolvedRuntime, model: string) => Promise<void>,
): Promise<void> {
  const slash = choiceId.indexOf("/");
  const model = runtime.models.getModel(choiceId.slice(0, slash), choiceId.slice(slash + 1));
  if (model === undefined) throw new Error(`Model is no longer available: ${choiceId}`);
  await switchRuntime(await runtimeForModel(runtime, model), model.id);
}

/** A setting is a label plus the list of values it can take. */
interface SettingRow {
  id: string;
  label: string;
  /** Id of the value in use, preselected when the value list opens. */
  current: () => string;
  choices: () => readonly Choice[];
  load?: () => Promise<readonly Choice[]>;
  apply: (choiceId: string) => Promise<void>;
}

function settingValue(row: SettingRow): string {
  const current = row.current();
  return row.choices().find((choice) => choice.id === current)?.label ?? current;
}

export async function runCommand(
  ui: Ui,
  context: CommandContext,
  parsed: ParsedSlashCommand,
  delivery: "steer" | "queue" = "steer",
): Promise<void> {
  const target = context.getTarget();
  const commandDefinition = resolveSlashCommand(parsed.name);
  if (commandDefinition === undefined) {
    if (target.harness.getCommands().has(parsed.name)) {
      const output = await target.harness.runCommand(parsed.name, parsed.argument);
      await context.refreshPluginState();
      if (output !== undefined) note(ui, output);
      return;
    }
    const skill = target.harness.getResources().get(parsed.name);
    if (skill !== undefined) {
      // pi's agent-session pattern: expand the skill to its invocation text,
      // then admit it like chat input so it steers or queues while a run is
      // active instead of failing with "a run is already active".
      const result = await target.harness.submit(
        formatSkillInvocation(skill, parsed.argument === "" ? undefined : parsed.argument),
        { delivery },
      );
      if (!result.ok) throw result.error;
      if (result.value.disposition === "queued") {
        const invocation =
          parsed.argument === "" ? `/${parsed.name}` : `/${parsed.name} ${parsed.argument}`;
        if (delivery === "steer") {
          ui.steeringStatus.show(result.value.entryId, invocation);
        } else {
          note(ui, `Queued: ${invocation}`);
        }
      }
      return;
    }
    note(ui, `Unknown command: /${parsed.name}. Try /help.`, ui.transcript.theme.error);
    return;
  }
  const command = commandDefinition.name;
  const { argument } = parsed;

  if (command === "help") {
    await context.openCommandPalette();
    return;
  }

  if (command === "quit") {
    if (argument !== "") throw new Error("/quit takes no argument");
    await context.shutdown();
    return;
  }

  if (command === "resume") {
    if (argument !== "") throw new Error("/resume opens the chat picker and takes no argument");
    const currentId = target.sessionId;
    const sessions: Choice[] = [];
    for (const session of (await context.repo.list()).reverse()) {
      const label = await sessionLabel(context.repo, session.id);
      if (label === undefined) continue;
      sessions.push({
        id: session.id,
        label: `${label}${session.id === currentId ? " (current)" : ""}`,
        description: `${new Date(session.createdAt).toLocaleString()} · ${shortId(session.id)}`,
      });
    }
    if (sessions.length === 0) {
      flash(ui, "No saved chats");
      return;
    }
    const sessionId = await selectChoice(ui, "Resume chat", sessions, { selectedId: currentId });
    await context.resumeSession(sessionId);
    return;
  }

  if (command === "new") {
    if (argument !== "") throw new Error("/new takes no argument");
    await context.newSession();
    return;
  }

  const { harness } = target;
  const session = harness.session;

  if (command === "settings") {
    if (argument !== "") throw new Error("/settings takes no argument");
    await context.openSettings();
    return;
  }

  if (command === "name") {
    if (argument === "") {
      note(ui, "Usage: /name <chat name>", ui.transcript.theme.error);
      return;
    }
    await context.nameSession(argument);
    return;
  }

  if (command === "login") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before logging in");
    }
    const current = context.getRuntime();
    const models = current.models;
    const provider =
      argument === ""
        ? await pickProvider(ui, models, current.provider.id)
        : requireProvider(models, argument);
    const runtime = await loginProviderViaTui(ui, models, provider);
    if (runtime === undefined) throw new Error(`Couldn't log in to ${provider.name}`);
    await activateLoggedInRuntime({
      currentProviderId: current.provider.id,
      runtime,
      switchRuntime: context.switchRuntime,
    });
    return;
  }

  if (command === "logout") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before logging out");
    }
    const current = context.getRuntime();
    const provider =
      argument === ""
        ? await pickProvider(ui, current.models, current.provider.id)
        : requireProvider(current.models, argument);
    await current.models.logout(provider.id);
    note(ui, `Logged out of ${provider.name}`, ui.transcript.theme.ok);
    return;
  }

  if (command === "compact") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before compacting");
    }
    const result = await harness.compact(
      argument === "" ? undefined : { customInstructions: argument },
    );
    if (!result.ok) {
      if (result.error._tag === "NothingToCompact") {
        note(ui, result.error.message);
        return;
      }
      throw result.error;
    }
    return;
  }

  if (command === "provider") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before switching provider");
    }
    const current = context.getRuntime();
    const provider =
      argument === ""
        ? await pickProvider(ui, current.models, current.provider.id)
        : requireProvider(current.models, argument);
    if (provider.id === current.provider.id) {
      flash(ui, `Already using ${provider.name}`);
      return;
    }
    const runtime = await runtimeForProvider(ui, current.models, provider);
    if (runtime === undefined) throw new Error(`Couldn't log in to ${provider.name}`);
    await context.switchRuntime(runtime, defaultModel(runtime.models, provider.id).id);
    return;
  }

  if (command === "model") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before switching model");
    }
    const currentRuntime = context.getRuntime();
    const currentModel = harness.state.model.id;
    if (argument === "") {
      const { models } = currentRuntime;
      const choiceId = await selectChoice(ui, "Model", cachedModelChoices(models), {
        selectedId: `${currentRuntime.provider.id}/${currentModel}`,
        load: () => reloadModelChoices(models),
      });
      await switchToModelChoice(currentRuntime, choiceId, context.switchRuntime);
      return;
    }
    const selectedModel = findModelReference(
      cachedAuthenticatedModels(currentRuntime.models) ??
        (await loadAuthenticatedModels(currentRuntime.models)),
      currentRuntime.provider.id,
      argument,
    );
    if (selectedModel === undefined) {
      throw new Error(`Unknown model: ${argument}. Use provider/model to switch providers`);
    }
    if (
      selectedModel.provider === currentRuntime.provider.id &&
      selectedModel.id === currentModel
    ) {
      flash(ui, `Already using ${selectedModel.provider}/${selectedModel.id}`);
      return;
    }
    const nextRuntime = await runtimeForModel(currentRuntime, selectedModel);
    await context.switchRuntime(nextRuntime, selectedModel.id);
    return;
  }

  if (command === "effort") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before changing thinking level");
    }
    const levels = getSupportedThinkingLevels(harness.state.model);
    const selected =
      argument === ""
        ? await selectChoice(
            ui,
            "Thinking level",
            levels.map((level) => ({ id: level, label: level })),
            { selectedId: harness.state.thinkingLevel },
          )
        : argument;
    const level = levels.find((candidate) => candidate === selected);
    if (level === undefined) {
      throw new Error(`Unsupported thinking level: ${selected}. Use ${levels.join(", ")}`);
    }
    await context.changeThinkingLevel(level);
    return;
  }

  if (command === "cd") {
    if (argument === "") {
      note(ui, "Usage: /cd <directory>", ui.transcript.theme.error);
      return;
    }
    await context.changeDirectory(argument);
    return;
  }

  if (command === "tree") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before changing the session branch");
    }
    if (argument !== "") throw new Error("/tree opens the branch picker and takes no argument");
    const entries = await session.findEntries();
    if (entries.length === 0) {
      flash(ui, "No messages to branch from");
      return;
    }
    const leafId = await session.getLeafId("main");
    const selected = await selectChoice(ui, "Session branch", treeChoices(entries), {
      selectedId: leafId ?? TREE_ROOT_ID,
    });
    await context.navigateTo(selected === TREE_ROOT_ID ? null : selected);
    return;
  }

  if (command === "edit") {
    if (harness.state.isStreaming || harness.state.isCompacting) {
      throw new Error("Wait for the current operation before changing message history");
    }
    if (argument !== "") throw new Error("/edit opens the message picker and takes no argument");
    const sent = userMessageEntries(await session.getBranch("main"));
    if (sent.length === 0) {
      flash(ui, "No messages to edit");
      return;
    }
    const selected = await selectChoice(ui, "Edit message", messageChoices(sent), {
      selectedId: sent.at(-1)?.id,
    });
    await context.navigateTo(selected);
    return;
  }

  if (command === "plugins") {
    if (argument !== "") throw new Error("/plugins takes no argument");
    notePlugins(ui, harness);
    return;
  }

  if (command === "reload") {
    if (argument !== "") throw new Error("/reload takes no argument");
    const resolved = await resolveCliPlugins(
      await context.getTrustedWorkspace(),
      harness.state.model,
    );
    for (const failure of resolved.failures) {
      note(ui, `Plugin ${failure.path}: ${failure.error}`, ui.transcript.theme.error);
    }
    await harness.plugins.activate(resolved.plugins);
    await context.refreshPluginState();
    noteSkillsLoaded(ui, harness);
    return;
  }

  if (command === "update") {
    const outcome = await selfUpdate({
      ...(argument === "" ? {} : { version: argument }),
      // A transcript note cannot rewrite itself, so percent events are dropped
      // rather than stacking ten rows under one download.
      report: (event) => {
        if (event.kind === "downloading") note(ui, `Downloading ${event.asset}…`);
        else if (event.kind === "verified") note(ui, "Checksum verified.");
      },
    });
    const noteColor: Record<Severity, string | undefined> = {
      ok: undefined,
      warn: ui.transcript.theme.warning,
      fail: ui.transcript.theme.error,
    };
    note(ui, describeUpdateOutcome(outcome), noteColor[updateSeverity(outcome)]);
    return;
  }

  if (command === "skills") {
    if (argument !== "") throw new Error("/skills opens the skill palette and takes no argument");
    await context.openSkillPalette();
    return;
  }

  command satisfies never;
}

export function noteSkillsLoaded(ui: Ui, harness: AgentHarness): void {
  const count = harness.getResources().size;
  note(ui, `${String(count)} ${count === 1 ? "skill" : "skills"} loaded`);
}

function notePlugins(ui: Ui, harness: AgentHarness): void {
  const plugins = harness.plugins.list();
  if (plugins.length === 0) {
    note(ui, "No plugins");
    return;
  }
  for (const plugin of plugins) {
    const where = plugin.path === undefined ? plugin.source : `${plugin.source} ${plugin.path}`;
    if (plugin.status === "failed") {
      note(ui, `${plugin.id} ${where} failed: ${plugin.error}`, ui.transcript.theme.error);
    } else {
      note(ui, `${plugin.id} ${where}`);
    }
  }
  const commands = [...harness.getCommands().keys()];
  if (commands.length > 0) note(ui, `Commands: ${commands.map((name) => `/${name}`).join(" ")}`);
}

/** A plugin's question. Confirm and select open the picker; input captures the composer. */

export type TuiExit = { kind: "quit" } | { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

export async function runTui(flags: RunFlags): Promise<TuiExit> {
  const renderLog = createTuiRenderLog();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    enableMouseMovement: true,
    clearOnShutdown: true,
    // Bottom-pinned streaming repaints most of the viewport every time a line
    // wraps, because OpenTUI rewrites cells and never asks the terminal to
    // scroll. The work per second is the same at 30 or 60, but at 60 it lands
    // in half-size steps, which is the difference between a lurch and a slide.
    targetFps: 60,
  });
  renderLog?.attach(renderer);
  renderLog?.record({ kind: "run_started" });
  const startupAbort = new AbortController();
  const destroyed = new Promise<void>((resolve) => {
    renderer.on("destroy", () => {
      startupAbort.abort();
      process.nextTick(() => {
        renderLog?.record({
          kind: "renderer_destroyed",
          activeResources: process.getActiveResourcesInfo(),
        });
        resolve();
      });
    });
  });
  const ui = buildUi(renderer, THEME);
  ui.transcript.openPath = (path) => {
    void open(path);
  };
  let slashAutocomplete: SlashAutocomplete;
  let shutdown: (() => Promise<void>) | undefined;
  let exit: TuiExit = { kind: "quit" };
  const requestShutdown = (requestedExit: TuiExit = { kind: "quit" }) => {
    if (requestedExit.kind === "signal") exit = requestedExit;
    const close = shutdown;
    if (close === undefined) {
      renderer.destroy();
      return;
    }
    void close();
  };
  let acceptingStartupInput = true;
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (
      acceptingStartupInput &&
      ui.inputMode !== "auth" &&
      key.ctrl &&
      key.name === "c" &&
      !key.defaultPrevented
    ) {
      key.preventDefault();
      key.stopPropagation();
      requestShutdown({ kind: "signal", signal: "SIGINT" });
    }
  });
  const initialCwd = process.cwd();
  const disposers: Array<() => void> = [];
  const onSigint = () => requestShutdown({ kind: "signal", signal: "SIGINT" });
  const onSigterm = () => requestShutdown({ kind: "signal", signal: "SIGTERM" });
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const trustStore = createWorkspaceTrustStore();
    const initialWorkspace = await chooseTrustedWorkspace(
      ui,
      trustStore,
      initialCwd,
      "quit",
      startupAbort.signal,
      renderLog,
    );
    if (initialWorkspace === undefined) {
      renderLog?.record({
        kind: "startup_quit",
        activeResources: process.getActiveResourcesInfo(),
      });
      requestShutdown();
      await destroyed;
      return exit;
    }

    const settingsStore = new FileSettingsStore();
    let settings = await settingsStore.read(initialWorkspace.cwd);
    let resolvedRuntime = await resolveRuntime(flags, settings);
    if (resolvedRuntime === undefined) {
      const models = createCliModels();
      const provider = preferredRunProvider(models, flags.provider, settings);
      resolvedRuntime = await loginProviderViaTui(ui, models, provider);
    }
    if (resolvedRuntime === undefined) throw new Error("login failed");

    const opened = await openHarness(resolvedRuntime, flags, {
      settings,
      workspace: initialWorkspace,
    });
    const { suspended, sessionId, repo } = opened;
    const settingsByHarness = new WeakMap<AgentHarness, ResolvedSettings>();
    settingsByHarness.set(opened.harness, settings);
    const createTrustedHarness: CreateHostedHarness = async (runtime, session, options) => {
      const workspace = await trustStore.require(options.cwd);
      const nextSettings = await settingsStore.read(workspace.cwd);
      const created = await createHarness(
        runtime,
        session,
        { model: options.model, effort: options.effort, settings: nextSettings },
        workspace,
      );
      settingsByHarness.set(created.harness, nextSettings);
      return created;
    };
    const host = new HarnessHost({
      harness: opened.harness,
      runtime: resolvedRuntime,
      sessionId,
      cwd: opened.harness.env.cwd,
      createHarness: createTrustedHarness,
      authorizeWorkspace: async (cwd) => {
        const workspace = await chooseTrustedWorkspace(
          ui,
          trustStore,
          cwd,
          "cancel",
          undefined,
          renderLog,
        );
        if (workspace === undefined) throw new WorkspaceTrustRequired(cwd);
        return workspace.cwd;
      },
      // Draw what a transition writes and claim it, so the head move it causes
      // does not rebuild a transcript that is already correct.
      beforeAppend: (entries) => {
        for (const entry of entries) {
          markEntryRendered(ui, entry.id);
          const text = entryNote(entry);
          if (text !== undefined) note(ui, text);
        }
      },
    });
    const syncSettingsFromHarness = (): void => {
      const current = settingsByHarness.get(host.harness);
      if (current === undefined) throw new Error("Current harness has no resolved settings");
      settings = current;
    };
    const setCurrentSettings = (next: ResolvedSettings): void => {
      settings = next;
      settingsByHarness.set(host.harness, next);
    };
    ui.transcript.cwd = host.cwd;
    const composerParts = new ComposerParts();
    const composerTags = new ComposerTags({
      renderer,
      tags: ui.composerTagRow,
      preview: ui.composerPreview,
      syntaxStyle: ui.transcript.syntaxStyle,
      theme: ui.transcript.theme,
      nextId: ui.nextId,
      fileBody: (part) => composerParts.fileBody(part),
      openPath: (path) => ui.transcript.openPath?.(path),
    });
    const doubleEscape = new DoubleEscape();
    let mentionFiles: readonly MentionFile[] = [];
    let mentionFilesGeneration = 0;
    const closeTui = createTuiShutdown({
      unsubscribeHarness: () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose();
          } catch {}
        }
      },
      getHarness: () => ({ close: () => host.close() }),
      repo,
      renderer,
    });
    let shutdownStarted = false;
    let shutdownCompleted = false;
    shutdown = async () => {
      if (!shutdownStarted) {
        shutdownStarted = true;
        renderLog?.record({
          kind: "shutdown_started",
          activeResources: process.getActiveResourcesInfo(),
        });
      }
      await closeTui();
      if (!shutdownCompleted) {
        shutdownCompleted = true;
        renderLog?.record({
          kind: "shutdown_completed",
          activeResources: process.getActiveResourcesInfo(),
        });
        process.stdout.write(`${resumeSessionHint(host.sessionId)}\n`);
      }
    };
    void checkForUpdate().then(async (notice) => {
      if (notice === undefined || shutdownStarted) return;
      if (!settings.autoUpdate) {
        note(
          ui,
          `Update available: ${notice.version} · /update to install`,
          ui.transcript.theme.warning,
        );
        return;
      }
      const outcome = await selfUpdate();
      if (shutdownStarted) return;
      if (outcome.kind === "updated") {
        note(ui, describeUpdateOutcome(outcome));
        return;
      }
      note(
        ui,
        `Update available: ${notice.version} · ${describeUpdateOutcome(outcome)}`,
        ui.transcript.theme.warning,
      );
    });
    const usageStatus = async (): Promise<Partial<PowerlineState>> => {
      const branch = await host.harness.session.getBranch("main");
      const lastUsage = getLastAssistantUsage(branch);
      const tokens = estimateContextTokens(buildSessionContext(branch)).tokens;
      const contextWindow = host.harness.state.model.contextWindow;
      return {
        ...(lastUsage === undefined ? {} : { tokens: calculateContextTokens(lastUsage) }),
        ...(contextWindow > 0 ? { pct: Math.round((tokens / contextWindow) * 100) } : {}),
      };
    };
    const model = host.harness.state.model.id;
    const workspace = await readWorkspaceStatus(host.cwd);
    const status = new ComposerStatus(
      renderer,
      ui.powerline,
      ui.transcript.theme,
      () => ui.input.focused || ui.inputBox.focused,
      {
        runState: "idle",
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
        model,
        effort: host.harness.state.thinkingLevel,
        statuses: await settingStatuses(host.harness),
        queued: 0,
        ...(await usageStatus()),
        ...(providerCacheTtlMs(host.harness.state.model.provider) === undefined
          ? {}
          : { cacheTtlMs: providerCacheTtlMs(host.harness.state.model.provider) }),
      },
    );
    disposers.push(() => status.dispose());
    // The composer's border swaps color on focus; the rule that closes its
    // frame has to swap with it.
    for (const event of [RenderableEvents.FOCUSED, RenderableEvents.BLURRED]) {
      ui.input.on(event, status.repaint);
      disposers.push(() => ui.input.off(event, status.repaint));
    }
    const refreshPluginState = async (): Promise<void> => {
      status.set({ statuses: await settingStatuses(host.harness) });
    };
    const unsubscribeHarness = host.bind((harness, cwd) =>
      wireHarness(ui, harness, status, cwd, () => harness === host.harness),
    );
    disposers.push(unsubscribeHarness);
    const unsubscribeSettings = host.bind((harness) =>
      harness.subscribe(async (event) => {
        if (event.type !== "agent_start") return;
        await settingsStore.updateGlobal({
          defaultProvider: host.runtime.provider.id,
          defaultModel: harness.state.model.id,
          defaultThinkingLevel: harness.state.thinkingLevel ?? "off",
        });
      }),
    );
    disposers.push(unsubscribeSettings);
    const unsubscribeWatcher = host.bind((harness, cwd) =>
      watchPluginDirectories({
        directories: [
          ...pluginDirectories(cwd),
          ...skillDirectories(cwd).map((path) => ({ path })),
        ],
        onChange: async () => {
          const resolved = await resolveCliPlugins(
            await trustStore.require(cwd),
            harness.state.model,
          );
          for (const failure of resolved.failures) {
            note(ui, `Plugin ${failure.path}: ${failure.error}`, ui.transcript.theme.error);
          }
          await harness.plugins.activate(resolved.plugins);
          await refreshPluginState();
          noteSkillsLoaded(ui, harness);
        },
        onError: (error) =>
          note(ui, `plugin reload failed: ${error.message}`, ui.transcript.theme.error),
      }),
    );
    disposers.push(unsubscribeWatcher);
    const initialBranch = await host.harness.session.getBranch("main");
    const promptHistory = new PromptHistory();
    promptHistory.replace(userPromptHistory(initialBranch));
    // Keyed on the session: a model, thinking level, or directory change swaps
    // the harness but keeps the session, and restarting the watch there would
    // republish the whole branch and redraw the chat for nothing.
    const unsubscribeSessionObserver = host.bind(
      (harness) => {
        const watched = harness.session;
        const isCurrent = (): boolean => host.harness.session === watched;
        return watchSessionBranch(watched, {
          head: "main",
          // Rebuild only for head moves the live event path did not draw.
          shouldReload: (leafId) =>
            !isCurrent() || shouldReloadTranscript(ui, host.harness, leafId),
          onBranch(entries) {
            if (!isCurrent()) return;
            promptHistory.replace(userPromptHistory(entries));
            if (host.harness.state.isBusy) return;
            replaceTranscript(ui, entries);
          },
          onError(error) {
            if (isCurrent()) {
              note(ui, `Session watch failed: ${error.message}`, ui.transcript.theme.error);
            }
          },
        });
      },
      { dependsOn: (harness) => harness.session },
    );
    disposers.push(unsubscribeSessionObserver);

    const switchRuntime = async (
      nextRuntime: ResolvedRuntime,
      nextModel: string,
    ): Promise<void> => {
      const badgesBefore = await activeSettingBadges(host.harness);
      if (!(await host.switchRuntime(nextRuntime, nextModel))) {
        flash(ui, `Already using ${nextModel}`);
        return;
      }
      syncSettingsFromHarness();
      status.set({
        model: nextModel,
        effort: host.harness.state.thinkingLevel,
        statuses: await settingStatuses(host.harness),
      });
      setCurrentSettings({
        ...settings,
        defaultProvider: nextRuntime.provider.id,
        defaultModel: nextModel,
      });
      await settingsStore.updateGlobal({
        defaultProvider: nextRuntime.provider.id,
        defaultModel: nextModel,
      });
      const settingsAfter = host.harness.getSettings();
      for (const [id, badge] of badgesBefore) {
        if (!settingsAfter.has(id)) note(ui, `${badge.label} unavailable for ${nextModel}`);
      }
    };

    const changeDirectory = async (input: string): Promise<void> => {
      const nextCwd = await host.changeDirectory(input);
      if (nextCwd === undefined) {
        flash(ui, `Already in ${host.cwd}`);
        return;
      }
      syncSettingsFromHarness();
      const workspace = await readWorkspaceStatus(host.cwd);
      ui.transcript.cwd = host.cwd;
      status.set({
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
      });
      // The claimed cwd_change entry already drew the new directory.
      await refreshMentionFiles(host.cwd);
    };

    const changeThinkingLevel = async (level: ThinkingLevel, announce = true): Promise<void> => {
      if (!(await host.changeThinkingLevel(level))) {
        if (announce) flash(ui, `Already using ${level}`);
        return;
      }
      syncSettingsFromHarness();
      status.set({ effort: host.harness.state.thinkingLevel });
      setCurrentSettings({ ...settings, defaultThinkingLevel: level });
      await settingsStore.updateGlobal({ defaultThinkingLevel: level });
      if (announce) note(ui, `Thinking level: ${level}`, ui.transcript.theme.ok);
    };

    const settleVisibleRun = (harness: AgentHarness, outcome: RunOutcome): void => {
      if (host.harness !== harness) return;
      if (ui.activeTurn !== undefined) {
        if (outcome.kind === "failed") {
          ui.activeTurn.addNote(`Error: ${outcome.error.message}`, ui.transcript.theme.error);
        }
        if (outcome.kind === "completed") ui.activeTurn.settle();
        else ui.activeTurn.settle(outcome.kind);
        ui.activeTurn = undefined;
      }
    };

    const failVisibleOperation = (harness: AgentHarness, message: string): void => {
      if (host.harness !== harness) return;
      turnNote(ui, message, ui.transcript.theme.error);
      if (!harness.state.isStreaming && !harness.state.isCompacting) {
        ui.activeTurn?.settle("failed");
        ui.activeTurn = undefined;
      }
    };

    const syncVisibleHarnessState = (harness: AgentHarness): void => {
      if (host.harness !== harness) return;
      status.set({
        runState: harness.state.isCompacting
          ? "compacting"
          : harness.state.isStreaming
            ? "working"
            : "idle",
      });
      ui.input.placeholder =
        harness.state.isStreaming || harness.state.isCompacting
          ? BUSY_COMPOSER_PLACEHOLDER
          : COMPOSER_PLACEHOLDER;
      refreshHints(ui, harness);
    };

    const resumeSuspended = (harness: AgentHarness): void => {
      status.set({ runState: "resuming" });
      ui.input.placeholder = BUSY_COMPOSER_PLACEHOLDER;
      void harness
        .resume()
        .then((result) => {
          if (!result.ok) {
            failVisibleOperation(harness, `Resume failed: ${result.error.message}`);
            return;
          }
          if (result.value.operation === "run") settleVisibleRun(harness, result.value);
        })
        .catch((error: unknown) => {
          failVisibleOperation(
            harness,
            `Resume failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => syncVisibleHarnessState(harness));
    };

    const observeStartedRun = (harness: AgentHarness): void => {
      void harness
        .waitForIdle()
        .then((result) => {
          if (result?.ok === true && !("operation" in result.value)) {
            settleVisibleRun(harness, result.value);
          }
        })
        .catch((error: unknown) => {
          failVisibleOperation(
            harness,
            `Run failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => syncVisibleHarnessState(harness));
    };

    const showRunner = async (
      nextSessionId: string,
      nextSuspended: readonly SuspendedOperation[],
    ): Promise<void> => {
      ui.input.clear();
      ui.input.placeholder = COMPOSER_PLACEHOLDER;
      ui.focus.reset();
      refreshHints(ui, host.harness);
      const branch = await host.harness.session.getBranch("main");
      ui.transcript.cwd = host.cwd;
      const hasSuspendedRun = nextSuspended.some((operation) => operation.kind === "run");
      replaceTranscript(ui, branch, {
        openLastTurn: host.harness.state.isStreaming || hasSuspendedRun,
      });
      promptHistory.replace(userPromptHistory(branch));
      const workspace = await readWorkspaceStatus(host.cwd);
      status.set({
        runState: host.harness.state.isCompacting
          ? "compacting"
          : host.harness.state.isStreaming
            ? "working"
            : "idle",
        workspace: workspace.name,
        branch: workspace.branch,
        dirty: workspace.dirty,
        model: host.harness.state.model.id,
        effort: host.harness.state.thinkingLevel,
        statuses: await settingStatuses(host.harness),
        queued: 0,
        ...(await usageStatus()),
      });
      turnNote(ui, `Resumed ${shortId(nextSessionId)} · ${String(branch.length)} entries`);
      if (nextSuspended.length > 0) resumeSuspended(host.harness);
    };

    let switchingSession = false;
    const resumeSession = async (nextSessionId: string): Promise<void> => {
      if (nextSessionId === host.sessionId) {
        note(ui, `Already in ${shortId(nextSessionId)}`);
        return;
      }
      if (switchingSession) throw new Error("A chat switch is already in progress");
      switchingSession = true;
      try {
        const { suspended: nextSuspended } = await host.activateSession(nextSessionId, () =>
          repo.open(nextSessionId),
        );
        syncSettingsFromHarness();
        await showRunner(nextSessionId, nextSuspended);
      } finally {
        switchingSession = false;
      }
    };

    const newSession = async (): Promise<void> => {
      const session = await repo.create();
      const metadata = await session.getMetadata();
      await host.switchSession(session, metadata.id);
      syncSettingsFromHarness();
      ui.input.clear();
      ui.input.placeholder = COMPOSER_PLACEHOLDER;
      ui.focus.reset();
      refreshHints(ui, host.harness);
      replaceTranscript(ui, []);
      promptHistory.replace([]);
      status.set({
        runState: "idle",
        statuses: await settingStatuses(host.harness),
        queued: 0,
        tokens: undefined,
        pct: undefined,
      });
    };

    const nameSession = async (name: string): Promise<void> => {
      await host.harness.session.setName(name);
      note(ui, `Chat named ${name}`, ui.transcript.theme.ok);
    };

    let commandContext: CommandContext;

    const openSettings = async (): Promise<void> => {
      if (host.harness.state.isStreaming || host.harness.state.isCompacting) {
        throw new Error("Wait for the current operation before changing settings");
      }
      if (ui.selecting) throw new Error("Another menu is already open");

      // Prefetched because read() is durable-storage I/O and settingValue()
      // runs during a sync render.
      const pluginSettings = [...host.harness.getSettings()];
      const settingValues = new Map(
        await Promise.all(
          pluginSettings.map(async ([id, setting]) => [id, await setting.read()] as const),
        ),
      );
      const pluginRows = pluginSettings.map(([id, setting]): SettingRow => ({
        id: `plugin:${id}`,
        label: setting.label,
        current: () => settingValues.get(id) ?? setting.choices[0].id,
        choices: () =>
          setting.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        apply: async (choiceId) => {
          await setting.apply(choiceId);
          settingValues.set(id, choiceId);
          await refreshPluginState();
        },
      }));

      const rows: readonly SettingRow[] = [
        {
          id: "model",
          label: "Model",
          current: () => `${host.runtime.provider.id}/${host.harness.state.model.id}`,
          choices: () => cachedModelChoices(host.runtime.models),
          load: () => reloadModelChoices(host.runtime.models),
          apply: (choiceId) => switchToModelChoice(host.runtime, choiceId, switchRuntime),
        },
        {
          id: "thinking",
          label: "Thinking level",
          current: () => host.harness.state.thinkingLevel ?? "off",
          choices: () =>
            getSupportedThinkingLevels(host.harness.state.model).map((level) => ({
              id: level,
              label: level,
            })),
          apply: async (choiceId) => {
            const level = getSupportedThinkingLevels(host.harness.state.model).find(
              (candidate) => candidate === choiceId,
            );
            if (level === undefined) throw new Error(`Unsupported thinking level: ${choiceId}`);
            await changeThinkingLevel(level, false);
          },
        },
        {
          id: "auto-compact",
          label: "Auto-compact",
          current: () => (settings.compaction.enabled ? "on" : "off"),
          choices: () => [
            { id: "on", label: "on", description: "Compact the thread before it overflows" },
            { id: "off", label: "off", description: "Keep every entry until you /compact" },
          ],
          apply: async (choiceId) => {
            const compaction = { ...settings.compaction, enabled: choiceId === "on" };
            host.harness.setCompactionSettings(compaction);
            setCurrentSettings({ ...settings, compaction });
            await settingsStore.updateGlobal({ compaction: { enabled: compaction.enabled } });
          },
        },
        {
          id: "auto-update",
          label: "Auto-update",
          current: () => (settings.autoUpdate ? "on" : "off"),
          choices: () => [
            { id: "on", label: "on", description: "Install a newer release when uji starts" },
            { id: "off", label: "off", description: "Only say when one exists; /update installs" },
          ],
          apply: async (choiceId) => {
            const autoUpdate = choiceId === "on";
            setCurrentSettings({ ...settings, autoUpdate });
            await settingsStore.updateGlobal({ autoUpdate });
          },
        },
        {
          id: "transport",
          label: "Transport",
          current: () => settings.transport,
          choices: () => TRANSPORTS.map((transport) => ({ id: transport, label: transport })),
          apply: async (choiceId) => {
            const transport = TRANSPORTS.find((candidate) => candidate === choiceId);
            if (transport === undefined) throw new Error(`Unknown transport: ${choiceId}`);
            host.harness.setStreamOptions({ transport });
            setCurrentSettings({ ...settings, transport });
            await settingsStore.updateGlobal({ transport });
          },
        },
        ...pluginRows,
      ];

      return new Promise<void>((resolve) => {
        const close = (): void => {
          closeInlineMenu(ui, menu);
          refreshHints(ui, host.harness);
          resolve();
        };

        const valueScreen = (row: SettingRow): MenuScreen => ({
          title: row.label,
          choices: row.choices(),
          ...(row.load === undefined ? {} : { load: row.load }),
          selectedId: row.current(),
          cancelLabel: "back",
          onCancel: () => showMain(row.id),
          onSelect: async (choiceId) => {
            await row.apply(choiceId);
            showMain(row.id);
          },
        });

        const mainScreen = (selectedId?: string): MenuScreen => ({
          title: "Settings",
          selectLabel: "open",
          choices: rows.map((row) => ({
            id: row.id,
            label: row.label,
            description: settingValue(row),
          })),
          ...(selectedId === undefined ? {} : { selectedId }),
          onCancel: close,
          onSelect: (id) => {
            const row = rows.find((candidate) => candidate.id === id);
            if (row === undefined) throw new Error(`Unknown setting: ${id}`);
            showMenuScreen(ui, menu, valueScreen(row));
          },
        });

        const showMain = (selectedId?: string): void =>
          showMenuScreen(ui, menu, mainScreen(selectedId));

        const menu = openInlineMenu(ui, mainScreen(), reportCommandError);
      });
    };

    /**
     * A palette pick that needs an argument lands in front of whatever is
     * already drafted instead of replacing it. For a skill prompt the draft is
     * the argument, and for the rest a visible `/name ` in front of your text
     * beats a message that vanished when you opened a menu.
     */
    const prefillComposer = (text: string): void => {
      setInputText(ui.input, `${text}${ui.input.plainText}`);
      ui.input.focus();
    };

    const openCommandPalette = async (): Promise<void> => {
      const commands = availableSlashCommands(host.harness.getCommands(), new Map());
      const selectedName = await selectChoice(
        ui,
        "Commands",
        commands.map((command) => ({
          id: command.name,
          label: slashCommandLabel(command),
          description: command.description,
        })),
      );
      const selected = commands.find((command) => command.name === selectedName);
      if (selected === undefined || selected.name === "help") return;
      if (resolveSlashCommand(selected.name) !== undefined) {
        const acceptance = acceptSlashCommand(selected, "return");
        if (acceptance.action === "complete") {
          prefillComposer(acceptance.text);
          return;
        }
      }
      await runCommand(ui, commandContext, { name: selected.name, argument: "" });
    };

    const openSkillPalette = async (): Promise<void> => {
      const items = skillPaletteItems(host.harness.getResources());
      if (items.length === 0) {
        flash(ui, "No skills found. Add SKILL.md to .uji/skills.");
        return;
      }
      const selectedName = await selectChoice(ui, "Skills", items);
      prefillComposer(`/${selectedName} `);
    };

    const focusComposer = (): void => {
      ui.focus.reset();
      refreshHints(ui, host.harness);
    };
    const focusScrollback = (): void => {
      ui.focus.use(ui.scroll);
      refreshHints(ui, host.harness);
    };
    const clearComposer = (): void => {
      composerParts.clear();
      promptHistory.resetBrowse();
      ui.input.clear();
      focusComposer();
    };

    const requireEditableHistory = (): void => {
      if (host.harness.state.isStreaming || host.harness.state.isCompacting) {
        throw new Error("Wait for the current operation before changing message history");
      }
    };

    /**
     * Landing on a message you sent takes it back instead of parking under it:
     * the head moves to its parent, the replies it drew leave the transcript,
     * and the message returns to the composer with its files and images still
     * attached. That round trip is the only way to edit what you already said,
     * so it never drops the text it pulls out of the chat. Any other entry is a
     * plain head move.
     *
     * Based on pi's `navigateTree`, which prefills its editor for the same reason:
     * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/session/agent-session.ts
     */
    const navigateTo = async (entryId: string | null): Promise<void> => {
      requireEditableHistory();
      const entry = entryId === null ? undefined : await host.harness.session.getEntry(entryId);
      if (entryId !== null && entry === undefined) {
        throw new Error(`No entry ${shortId(entryId)} in this chat`);
      }
      const sent =
        entry?.type === "message" && entry.message.role === "user" ? entry.message : undefined;
      // Holding the returning message would mean overwriting the draft already
      // in the composer, so refuse instead of choosing which text to lose.
      if (sent !== undefined && ui.input.plainText.trim() !== "") {
        throw new Error("Clear the composer before editing a message");
      }
      const target = sent === undefined ? entryId : (entry?.parentId ?? null);
      const leaf = await host.harness.session.getLeafId("main");
      if (target === leaf && sent === undefined) {
        flash(ui, "Already at that point in the chat");
        return;
      }
      // The picker was open for as long as the user took to read it.
      requireEditableHistory();
      if (target !== leaf) {
        ui.renderedEntries.clear();
        await host.harness.session.moveHead("main", target);
      }
      if (sent === undefined) {
        flash(
          ui,
          target === null
            ? "Moved to the start of the chat. The next message starts a branch."
            : `Moved to ${shortId(target)}. The next message starts a branch.`,
          ui.transcript.theme.ok,
        );
      } else {
        setInputText(ui.input, composerParts.load(sent.content));
        promptHistory.resetBrowse();
        flash(
          ui,
          "Message moved back to the composer. Enter sends it again.",
          ui.transcript.theme.ok,
        );
      }
      focusComposer();
    };

    commandContext = {
      repo,
      getTarget: () => ({ sessionId: host.sessionId, harness: host.harness }),
      getRuntime: () => host.runtime,
      getTrustedWorkspace: () => trustStore.require(host.harness.env.cwd),

      switchRuntime,
      changeDirectory,
      changeThinkingLevel,
      refreshPluginState,
      resumeSession,
      newSession,
      nameSession,
      openCommandPalette,
      openSettings,
      openSkillPalette,
      navigateTo,
      shutdown,
    };

    const reportCommandError = (error: unknown): void => {
      if (error instanceof PickerCancelled) return;
      note(ui, `error: ${errorMessage(error)}`, ui.transcript.theme.error);
    };

    /**
     * Queued prompts are reviewed the way opencode reviews them: one keyboard
     * menu over the composer, no pane and no mouse targets. Every action ends
     * the menu, so the composer is never left half-owned by a list.
     *
     * Based on opencode's queued-prompt panel:
     * https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/opencode/src/cli/cmd/run/footer.command.tsx
     */
    const deleteQueued = async (entryId: string): Promise<void> => {
      const result = await host.harness.cancelQueued(entryId);
      if (!result.ok) throw result.error;
      flash(ui, "Removed from the queue");
    };

    const openQueue = async (): Promise<void> => {
      const items = await host.harness.pendingQueue();
      if (items.length === 0) {
        flash(ui, "Nothing is queued");
        return;
      }
      const actions: ChoiceAction[] = [
        {
          key: "d",
          ctrl: true,
          label: "delete",
          run: (entryId) => void deleteQueued(entryId).catch(reportCommandError),
        },
      ];
      try {
        await selectChoice(
          ui,
          "Queued messages",
          items.map((item, index) => ({
            id: item.entryId,
            label: partsText(item.message.content).replaceAll("\n", " ").trim(),
            description: `${String(index + 1)} \u00b7 ${item.delivery === "nextRun" ? "next run" : item.delivery}`,
          })),
          { actions },
        );
      } catch (error) {
        if (!(error instanceof PickerCancelled)) throw error;
      }
    };

    slashAutocomplete = new SlashAutocomplete({
      renderer,
      input: ui.input,
      theme: ui.transcript.theme,
      nextId: ui.nextId,
      onCommand(command) {
        void runCommand(ui, commandContext, { name: command.name, argument: "" }).catch(
          reportCommandError,
        );
      },
      onFile(path) {
        return composerParts.addFile(path);
      },
      completeDirectories(query) {
        return discoverDirectorySuggestions(host.cwd, query);
      },
    });
    // Below the composer, the way every other terminal chat drops its
    // completions: the prompt stays put while the list grows downward.
    ui.root.insertBefore(slashAutocomplete.container, ui.hints);
    ui.closeInlineMenus = () => slashAutocomplete.close();
    // Warm the catalog so the first model menu opens on a full list.
    void loadAuthenticatedModels(host.runtime.models).catch(() => undefined);

    if (flags.resume.kind !== "new" && initialBranch.length > 0) {
      replaceTranscript(ui, initialBranch, {
        openLastTurn: suspended.some((operation) => operation.kind === "run"),
      });
      turnNote(ui, `Resumed · ${String(initialBranch.length)} entries`);
    }
    if (suspended.length > 0) {
      turnNote(ui, "Resuming…", ui.transcript.theme.tool);
      resumeSuspended(host.harness);
    }

    const refreshSlashAutocomplete = (value = ui.input.plainText): void => {
      if (ui.inputMode !== "chat" || ui.selecting) {
        slashAutocomplete.close();
        return;
      }
      slashAutocomplete.update(
        value,
        slashCommandsForHarness(host.harness),
        mentionFiles,
        host.cwd,
      );
    };
    const refreshMentionFiles = async (cwd: string): Promise<void> => {
      const generation = ++mentionFilesGeneration;
      const files = await discoverMentionFiles(cwd);
      if (generation !== mentionFilesGeneration || host.cwd !== cwd) return;
      mentionFiles = files;
      refreshSlashAutocomplete();
    };
    const syncComposerLayout = ui.input.onContentChange;
    ui.input.onContentChange = (event) => {
      syncComposerLayout?.(event);
      composerParts.retain(ui.input.plainText);
      // OpenTUI emits content changes for programmatic setText/clear too (on a
      // microtask, with a render following), so this is the one place the tag
      // row syncs; clear, load, restore, and submit all funnel through here.
      composerTags.refresh(composerParts.current);
      refreshSlashAutocomplete();
      if (ui.inputMode === "chat" && ui.input.plainText !== "") {
        refreshHints(ui, host.harness);
      }
    };
    ui.input.onKeyDown = (key) => {
      if (!isComposerTextKey(key)) return;
      if (ui.input.cursorOffset !== ui.input.plainText.length || ui.input.hasSelection()) return;
      // OpenCode opens `/` from keydown instead of waiting for the textarea's
      // content callback. Project every appended character so `/re` filters in
      // the same input pass; the matching content callback is then a no-op.
      refreshSlashAutocomplete(`${ui.input.plainText}${key.sequence}`);
    };
    refreshSlashAutocomplete();
    void refreshMentionFiles(host.cwd);
    const handleComposerPaste = (event: PasteEvent): void => {
      promptHistory.resetBrowse();
      event.preventDefault();
      if (
        event.metadata?.kind === "binary" ||
        event.metadata?.mimeType?.startsWith("image/") === true
      ) {
        const image = resolveComposerImagePaste(event.bytes);
        if (image === undefined) {
          note(ui, "paste failed: unsupported image data", ui.transcript.theme.error);
          return;
        }
        ui.input.insertText(`${composerParts.addImage(image.image)} `);
        return;
      }
      const value = decodePasteBytes(event.bytes);
      void resolveComposerPaste(value, host.cwd)
        .then((paste) => {
          if (paste.kind === "text") {
            // A tall paste collapses to a marker so the composer stays a
            // composer; the submitted message still carries every line.
            ui.input.insertText(
              pasteLineCount(paste.text) > PASTE_COLLAPSE_LINES
                ? `${composerParts.addPaste(paste.text)} `
                : paste.text,
            );
          } else if (paste.kind === "file") {
            ui.input.insertText(`${composerParts.addFile(paste.path)} `);
          } else {
            ui.input.insertText(`${composerParts.addImage(paste.image)} `);
          }
        })
        .catch((error: unknown) => {
          note(
            ui,
            `paste failed: ${error instanceof Error ? error.message : String(error)}`,
            ui.transcript.theme.error,
          );
        });
    };
    ui.input.onPaste = handleComposerPaste;

    ui.inputBox.onMouseDown = focusComposer;
    ui.scroll.onMouseDown = focusScrollback;
    ui.scroll.onPaste = (event) => {
      focusComposer();
      handleComposerPaste(event);
      event.stopPropagation();
    };

    const restoreRejectedInput = (text: string, parts: readonly ComposerPart[]): void => {
      if (ui.input.plainText !== "") return;
      composerParts.restore(parts);
      setInputText(ui.input, text);
    };

    let submitting = false;
    const submitComposer = (delivery: "steer" | "queue" = "steer"): void => {
      if (ui.inputMode !== "chat" || ui.selecting) return;
      if (slashAutocomplete.visible) return;
      if (submitting) return;
      const draft = ui.input.plainText;
      const submission = parseComposerSubmission(draft);
      if (submission.kind === "empty") return;
      // Snapshots the draft's parts synchronously, so clearing the composer on
      // the next line cannot strip them before their bodies finish loading.
      const preparing = submission.kind === "prompt" ? composerParts.prepare(draft) : undefined;
      submitting = true;
      ui.input.clear();
      promptHistory.resetBrowse();
      slashAutocomplete.close();
      if (submission.kind === "command") {
        void runCommand(ui, commandContext, submission.command, delivery).catch(reportCommandError);
      } else if (preparing !== undefined) {
        void (async () => {
          const prepared = await preparing;
          const text = prepared.displayText;
          promptHistory.record(text);
          const submittedHarness = host.harness;
          const result = await submittedHarness.submit(prepared.message, { delivery });
          if (!result.ok) {
            restoreRejectedInput(draft, prepared.parts);
            throw result.error;
          }
          if (result.value.disposition === "queued") {
            if (delivery === "steer") {
              ui.steeringStatus.show(result.value.entryId, text);
            } else {
              note(ui, `Queued: ${text}`);
            }
          } else {
            observeStartedRun(submittedHarness);
          }
        })().catch(reportCommandError);
      }
      // Guard the native submit and keypress paths in this input dispatch. Core
      // owns the longer admission/run serialization.
      queueMicrotask(() => {
        submitting = false;
      });
    };
    ui.input.onSubmit = () => {
      submitComposer();
      refreshHints(ui, host.harness);
    };

    let cyclingThinking = false;
    const cycleThinkingLevel = (): void => {
      if (cyclingThinking || host.harness.state.isStreaming || host.harness.state.isCompacting) {
        return;
      }
      const next = nextThinkingLevel(
        host.harness.state.thinkingLevel ?? "off",
        getSupportedThinkingLevels(host.harness.state.model),
      );
      if (next === undefined) return;
      cyclingThinking = true;
      void changeThinkingLevel(next, false)
        .catch(reportCommandError)
        .finally(() => {
          cyclingThinking = false;
        });
    };

    let cyclingModel = false;
    const cycleModel = (direction: "forward" | "backward"): void => {
      if (cyclingModel || host.harness.state.isStreaming || host.harness.state.isCompacting) {
        return;
      }
      cyclingModel = true;
      void (async () => {
        const { models } = host.runtime;
        const available =
          cachedAuthenticatedModels(models) ?? (await loadAuthenticatedModels(models));
        if (available.length < 2) return;
        const current = available.findIndex(
          (model) =>
            model.provider === host.runtime.provider.id && model.id === host.harness.state.model.id,
        );
        const delta = direction === "forward" ? 1 : -1;
        const index = current === -1 ? 0 : (current + delta + available.length) % available.length;
        const next = available[index];
        if (next === undefined) return;
        await switchRuntime(await runtimeForModel(host.runtime, next), next.id);
      })()
        .catch(reportCommandError)
        .finally(() => {
          cyclingModel = false;
        });
    };

    let editingExternally = false;
    const openExternalEditor = (): void => {
      if (editingExternally) return;
      editingExternally = true;
      slashAutocomplete.close();
      const draft = ui.input.plainText;
      ui.input.blur();
      renderer.suspend();
      void editInExternalEditor(draft, resolveExternalEditor(settings.externalEditor))
        .then((result) => {
          if (result.status === "completed") setInputText(ui.input, result.text);
          else reportCommandError(result.error);
        })
        .finally(() => {
          renderer.resume();
          ui.focus.reset();
          renderer.requestRender();
          editingExternally = false;
        });
    };

    acceptingStartupInput = false;
    const keymap = createChatKeymap(renderer);
    disposers.push(registerSelectionLayer(keymap, renderer));
    // Every key the layer consumes stops before this listener, so browsing has
    // to be reset here rather than from whatever survives the shortcuts.
    disposers.push(
      keymap.intercept("key", (ctx) => {
        if (ui.inputMode !== "chat" || ui.selecting) return;
        if (ctx.event.name === "up" || ctx.event.name === "down") return;
        promptHistory.resetBrowse();
      }),
    );
    disposers.push(
      registerChatLayer(keymap, {
        enabled: () =>
          ui.inputMode === "chat" &&
          !ui.selecting &&
          // An open completion answers these keys itself, from the listener
          // below. A drag selection has its own layer above this one.
          !slashAutocomplete.visible,
        commands: {
          "chat.interrupt": {
            title: "Stop the current run",
            run: () => {
              const intent = escapeIntent({
                selecting: ui.selecting,
                inputMode: ui.inputMode,
                authenticating: ui.authenticating,
                hasDraft: ui.input.plainText.trim() !== "",
                busy: host.harness.state.isStreaming || host.harness.state.isCompacting,
                scrollbackFocused: ui.focus.isUsing(ui.scroll),
              });
              if (intent === "ignore") return false;
              if (intent === "abort") {
                void host.harness.abort({ continue: true });
                return true;
              }
              if (intent === "focus_composer") {
                focusComposer();
                return true;
              }
              // Double escape takes back what you said. It lists only the user
              // turns and hands the picked one to the composer, which is pi's
              // `showUserMessageSelector` rather than its default tree
              // selector: landing on a tool result or an assistant reply moves
              // the head without giving you anything to edit, and that is the
              // one thing this is for.
              // https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5119
              if (doubleEscape.press()) {
                void runCommand(ui, commandContext, { name: "edit", argument: "" }).catch(
                  reportCommandError,
                );
              }
              return true;
            },
          },
          "chat.focus.toggle": {
            title: "Switch between the transcript and the composer",
            run: () => {
              if (ui.focus.isUsing(ui.scroll)) focusComposer();
              else focusScrollback();
            },
          },
          "chat.thinking.cycle": {
            title: "Cycle the thinking level",
            run: cycleThinkingLevel,
          },
          "chat.model.next": {
            title: "Next model",
            run: () => {
              cycleModel("forward");
            },
          },
          "chat.model.previous": {
            title: "Previous model",
            run: () => {
              cycleModel("backward");
            },
          },
          "chat.editor.open": {
            title: "Edit the draft in your editor",
            run: openExternalEditor,
          },
          "chat.queue.open": {
            title: "Manage queued messages",
            run: () => {
              void openQueue().catch(reportCommandError);
            },
          },
          "chat.queue.submit": {
            title: "Queue the draft instead of steering",
            run: () => {
              if (ui.input.plainText.trim() === "") return false;
              submitComposer("queue");
              return true;
            },
          },
          "chat.skills.open": {
            title: "Run a skill",
            run: () => {
              focusComposer();
              void openSkillPalette().catch(reportCommandError);
            },
          },
          "chat.commands.open": {
            title: "Open the command palette",
            run: () => {
              focusComposer();
              void openCommandPalette().catch(reportCommandError);
            },
          },
          // Plain up/down inside a multi-line draft move the cursor; history
          // only takes over from the first and last line, as in a shell.
          "chat.history.previous": {
            title: "Previous message you sent",
            run: () => {
              if (ui.focus.isUsing(ui.scroll) || ui.input.logicalCursor.row !== 0) return false;
              const previous = promptHistory.previous(ui.input.plainText);
              if (previous === undefined) return false;
              setInputText(ui.input, previous);
              return true;
            },
          },
          "chat.history.next": {
            title: "Next message you sent",
            run: () => {
              if (ui.focus.isUsing(ui.scroll)) return false;
              const onLastRow = ui.input.logicalCursor.row >= ui.input.lineCount - 1;
              if (!onLastRow && promptHistory.browsing) return false;
              const next = promptHistory.next();
              if (next === undefined) return false;
              setInputText(ui.input, next);
              return true;
            },
          },
        },
      }),
    );
    // What the keymap deliberately leaves alone: quitting, which outranks the
    // chat layer's `enabled` gate, and the two surfaces that answer arbitrary
    // keys rather than a fixed set.
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.defaultPrevented) return;
      if (slashAutocomplete.handleKey(key)) return;
      const action = tuiKeyAction(key, {
        selecting: ui.selecting,
        inputMode: ui.inputMode,
        authenticating: ui.authenticating,
        hasDraft: ui.input.plainText !== "",
      });
      if (action === "clear_for_quit") {
        key.preventDefault();
        key.stopPropagation();
        clearComposer();
        setHints(ui, CTRL_C_EXIT_HINT);
        return;
      }
      if (
        ui.inputMode === "chat" &&
        !ui.selecting &&
        ui.focus.isUsing(ui.scroll) &&
        isComposerTextKey(key)
      ) {
        key.preventDefault();
        key.stopPropagation();
        focusComposer();
        ui.input.insertText(key.sequence);
        return;
      }
      if (action === "shutdown") {
        key.preventDefault();
        key.stopPropagation();
        requestShutdown({ kind: "signal", signal: "SIGINT" });
      }
    });

    await destroyed;
    const close = shutdown;
    if (close === undefined) throw new Error("TUI shutdown was not initialized");
    await close();
    return exit;
  } catch (error) {
    renderLog?.record({
      kind: "run_failed",
      error: renderLogError(error),
      activeResources: process.getActiveResourcesInfo(),
    });
    requestShutdown();
    await destroyed;
    await shutdown?.();
    throw error;
  } finally {
    removeSignalHandlers();
    renderLog?.close();
  }
}
