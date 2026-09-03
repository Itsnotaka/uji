import { stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import open from "open";
import { createCliRenderer, decodePasteBytes, RenderableEvents } from "@opentui/core";
import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";
import { getSupportedThinkingLevels } from "@uji-ai/ai";
import type { Api, AuthInteraction, AuthPrompt, Model, Models, Provider } from "@uji-ai/ai";
import {
  WorkspaceTrustRequired,
  collectAbandonedEntries,
  navigationTarget,
  projectSessionTree,
  sessionId as parseSessionId,
  watchPluginDirectories,
} from "@uji-ai/core";
import type {
  PendingItem,
  SessionEvent,
  SessionId,
  ThinkingLevel,
  TrustedWorkspace,
  Uji,
  WorkspaceTrustStore,
} from "@uji-ai/core";
import type { JsonValue, Skill, UserMessage } from "@uji-ai/schema";
import {
  cachedAuthenticatedModels,
  createCliModels,
  defaultModel,
  loadAuthenticatedModels,
  loadProviderCatalog,
  providerAuthStatuses,
  requireModel as requireCatalogModel,
  requireProvider,
} from "./catalog.ts";
import type { ProviderAuthStatus } from "./catalog.ts";
import {
  ComposerParts,
  discoverMentionFiles,
  PASTE_COLLAPSE_LINES,
  pasteLineCount,
  resolveComposerImagePaste,
  resolveComposerPaste,
  SessionDrafts,
} from "./composer.ts";
import type { ComposerPart, MentionFile } from "./composer.ts";
import { ComposerMarkers } from "./composer-markers.ts";
import { browseHistory, PromptHistory } from "./prompt-history.ts";
import { discoverDirectorySuggestions, resolveDirectory } from "./directory-autocomplete.ts";
import {
  clockDuration,
  parseComposerSubmission,
  partsText,
  retryCause,
  shortId,
  TERMINAL_TITLE_BASE,
  terminalTitle,
} from "./format.ts";
import type { ParsedSlashCommand, PowerlineState } from "./format.ts";
import { UjiHost } from "./uji-host.ts";
import { createChatNamer } from "./session-title.ts";
import type { ChatNamer } from "./session-title.ts";
import { createChatKeymap, registerChatLayer, registerSelectionLayer } from "./keymap.ts";
import {
  createTuiShutdown,
  DoubleEscape,
  escapeIntent,
  isComposerTextKey,
  nextThinkingLevel,
  stoppedTurnIntent,
  tuiKeyAction,
} from "./lifecycle.ts";
import { editInExternalEditor, resolveExternalEditor } from "./external-editor.ts";
import type { RunFlags } from "./run.ts";
import {
  hostFallbacks,
  manifestPluginOptions,
  pluginDirectories,
  preferredRunProvider,
  resolveRuntime,
  skillDirectories,
} from "./run.ts";
import type { ResolvedRuntime } from "./run.ts";
import { FileSettingsStore, TRANSPORTS } from "./settings.ts";
import type { ResolvedSettings } from "./settings.ts";
import { notifyRunEvent, RUN_NOTIFICATION_MODES } from "./notifications.ts";
import type { RunNotificationMode } from "./notifications.ts";
import { createTuiRenderLog, renderLogError } from "./render-log.ts";
import type { TuiRenderLog } from "./render-log.ts";
import { nextToSteer } from "./pending-gutter.ts";
import { PickerCancelled } from "./picker.ts";
import type { Choice, ChoiceAction, MenuScreen } from "./picker.ts";
import { SlashAutocomplete } from "./slash-autocomplete.ts";
import { selectTreeEntry } from "./tree-selector.ts";
import type { TreeFilter } from "./tree-selector.ts";
import { watchSessionBranch } from "./session-observer.ts";
import {
  acceptSlashCommand,
  availableSlashCommands,
  expandInlineSkills,
  hasInlineSkills,
  resolveSlashCommand,
  skillPaletteItems,
  slashCommandLabel,
} from "./slash.ts";
import type { SlashCommand } from "./slash.ts";
import { appendAuthUrl, ConversationTurnBlock } from "./transcript.ts";
import { resolveThemeMode, themeForMode } from "./theme.ts";
import type { ThemeMode } from "./theme.ts";
import { type Severity, updateSeverity } from "./cli-style.ts";
import { describeUpdateOutcome, selfUpdate } from "./update.ts";
import { collectWorkspaceUsage, usageCard } from "./usage.ts";
import { checkForUpdate } from "./version.ts";
import { cellIndex, displayWidth, graphemes } from "./width.ts";
import {
  AUTH_URL_HINTS,
  BUSY_HINTS,
  BUSY_COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER,
  CTRL_C_EXIT_HINT,
  DELIVERY,
  IDLE_HINTS,
  keycap,
  TOOL_CALL_DISPLAY_MODES,
} from "./constants.ts";
import { readWorkspaceStatus } from "./workspace.ts";
import { createWorkspaceTrustStore, requestWorkspaceTrust } from "./workspace-trust.ts";
import type { WorkspaceTrustDeclineAction } from "./workspace-trust.ts";

import {
  applyUiTheme,
  buildUi,
  closeInlineMenu,
  commitTranscriptEntry,
  ComposerStatus,
  notice,
  navigateTranscriptMessage,
  openInlineMenu,
  openUsageCard,
  openUserTurn,
  replaceTranscript,
  selectChoice,
  setHints,
  setInputText,
  showMenuScreen,
  turnNote,
} from "./tui.ts";
import type { Ui } from "./tui.ts";
import { SKILLS_PLUGIN_ID, formatSkillInvocation } from "@uji-ai/core/plugins";
import { newId, type Entry } from "@uji-ai/core/store";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshHints(ui: Ui, busy: boolean): void {
  setHints(ui, busy ? BUSY_HINTS : IDLE_HINTS);
}

/**
 * Close the open turn. A run stopped before it answered gives its message back
 * to the composer instead of settling to a `! Stopped` line, and the turn
 * leaves the screen with it. The block goes in the same tick the decision is
 * made, so the stopped line is never drawn and then taken away.
 */
function closeActiveTurn(ui: Ui): void {
  const turn = ui.activeTurn;
  ui.activeTurn = undefined;
  if (turn === undefined) return;
  const retract =
    turn.result === "aborted" &&
    stoppedTurnIntent({
      unanswered: turn.unanswered,
      hasDraft: ui.input.plainText.trim() !== "",
    }) === "retract" &&
    ui.retractPrompt?.() === true;
  if (retract) turn.discard();
  else turn.settle();
}

function concealComposerInput(ui: Ui): () => void {
  const input = ui.input;
  const previousContentChange = input.onContentChange;
  const paint = (): void => {
    input.extmarks.clear();
    let offset = 0;
    for (const grapheme of graphemes(input.plainText)) {
      const width = grapheme === "\n" ? 1 : displayWidth(grapheme);
      if (width === 0) continue;
      input.extmarks.create({
        start: offset,
        end: offset + width,
        virtual: true,
        data: "●".repeat(width),
      });
      offset += width;
    }
  };
  input.onContentChange = (event) => {
    previousContentChange?.(event);
    paint();
  };
  paint();
  return () => {
    input.onContentChange = previousContentChange;
    input.extmarks.clear();
  };
}

/**
 * One line typed into the composer under its own prompt label: enter resolves
 * it, escape rejects with `PickerCancelled`. The composer's submit handler and
 * placeholder come back either way.
 */
function readComposerLine(
  ui: Ui,
  isBusy: () => boolean,
  options: { placeholder?: string; prompt?: string; default?: string },
): Promise<string> {
  ui.dismissInfoPanel?.();
  if (ui.selecting) return Promise.reject(new Error("Another panel is already open"));
  return new Promise<string>((resolve, reject) => {
    ui.input.placeholder = options.placeholder ?? "";
    const previousPrompt = ui.prompt.content;
    const previousSubmit = ui.input.onSubmit;
    ui.prompt.content = options.prompt ?? "input > ";
    ui.inputMode = "auth";
    let settled = false;
    const finish = (): void => {
      ui.renderer.keyInput.off("keypress", onKeyPress);
      ui.input.placeholder = isBusy() ? BUSY_COMPOSER_PLACEHOLDER : COMPOSER_PLACEHOLDER;
      ui.prompt.content = previousPrompt;
      ui.inputMode = "chat";
      ui.input.onSubmit = previousSubmit;
    };
    const onEnter = (): void => {
      if (settled) return;
      settled = true;
      const text = ui.input.plainText;
      const value = text === "" && options.default !== undefined ? options.default : text;
      ui.input.clear();
      finish();
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
}

/** What the wire reads from a host: the SDK, active session, run state, and events. */
interface WireSessionHost {
  readonly sdk: Uji;
  readonly sessionId: SessionId;
  readonly state: Pick<UjiHost["state"], "operation">;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

/** The footer's context segment, from core's usage fold. */
async function usageStatus(host: WireSessionHost): Promise<Partial<PowerlineState>> {
  const context = await host.sdk.runs.context({ sessionId: host.sessionId });
  return {
    tokens: context.usageTokens,
    ...(context.percent === undefined ? {} : { pct: context.percent }),
  };
}

interface WireSessionOptions {
  status: ComposerStatus;
  cwd: string;
  /** Names the chat when a user message lands. */
  namer?: ChatNamer;
  runNotifications: () => RunNotificationMode;
  /** Setting badges moved; the composition re-lists and patches the status. */
  onPluginsChanged?: () => void;
  isVisible?: () => boolean;
}

/**
 * Bridge the active session's `watch` stream onto the terminal. The durable
 * transcript is drawn by the branch watcher over storage; this handles what
 * only the live stream knows: streaming deltas at their part identity, tool
 * progress, run state, retry banners, the pending queue, and diagnostics.
 */
function wireSession(ui: Ui, host: WireSessionHost, options: WireSessionOptions): () => void {
  const { status, cwd } = options;
  const isVisible = options.isVisible ?? (() => true);
  // The directory watcher reactivates plugins on every save under a plugin or
  // skill directory, so this event repeats when nothing about the set changed.
  // Note the set only when it actually moves.
  let lastPluginSignature: string | undefined;

  const ensureTurn = (): ConversationTurnBlock => {
    ui.activeTurn ??= new ConversationTurnBlock(ui.transcript);
    return ui.activeTurn;
  };

  const runNote = (text: string, color?: string): void => {
    turnNote(ui, text, color);
  };

  const refreshWorkspace = (): void => {
    void readWorkspaceStatus(cwd).then((workspace) => {
      if (isVisible()) status.patch(workspace);
    });
  };

  const refreshUsage = (): void => {
    void usageStatus(host)
      .then((usage) => {
        if (isVisible()) status.patch(usage);
      })
      .catch(() => undefined);
  };

  const countQueue = (): void => {
    status.patch({ queued: ui.queue.pending.length });
  };

  const unsubscribe = host.subscribe((event) => {
    if (!isVisible()) return;
    switch (event.kind) {
      case "text_delta":
        ensureTurn().appendAssistantDelta(event.contentIndex, event.delta, event.entryId);
        break;
      case "reasoning_delta":
        ensureTurn().appendReasoningDelta(event.contentIndex, event.delta, event.entryId);
        break;
      case "tool_progress":
        ensureTurn().updateTool(event.callId, event.progress.text, event.progress.title);
        break;
      case "message": {
        // A deferred item leaves for the record without a `queue_consumed`.
        ui.queue.resolve(event.entryId);
        countQueue();
        if (event.turn.kind !== "turn") break;
        for (const part of event.turn.parts) {
          if (part.kind === "user") {
            // Drawn eagerly so streaming deltas join this turn; the branch
            // watcher's later fold of the same entry is an identity no-op.
            openUserTurn(ui, part.entryId, part.content);
            options.namer?.onUserMessage();
          }
          if (part.kind === "tool" && part.result === undefined) {
            ui.transcript.cwd = cwd;
          }
          if (part.kind === "assistant") refreshUsage();
        }
        break;
      }
      case "run_started":
        ui.input.placeholder = BUSY_COMPOSER_PLACEHOLDER;
        refreshHints(ui, true);
        if (event.operation === "compaction") runNote("Compacting…", ui.transcript.theme.tool);
        break;
      case "compacting":
        if (event.reason !== "manual") runNote("Auto-compacting…", ui.transcript.theme.tool);
        break;
      case "run_finished": {
        const { operation } = host.state;
        if (event.outcome.kind === "failed") {
          const prefix =
            operation === "compaction"
              ? "Compaction failed"
              : operation === "navigation"
                ? "Navigation failed"
                : "Error";
          runNote(`${prefix}: ${event.outcome.error.message}`, ui.transcript.theme.error);
        }
        if (operation === "run") {
          closeActiveTurn(ui);
          notifyRunEvent({
            end: event.outcome,
            mode: options.runNotifications(),
            renderer: ui.renderer,
          });
        }
        ui.input.placeholder = COMPOSER_PLACEHOLDER;
        refreshHints(ui, false);
        refreshWorkspace();
        refreshUsage();
        break;
      }
      case "retry_scheduled": {
        // Backoff is otherwise indistinguishable from a hang, so name the cause and the wait.
        runNote(
          `${retryCause(event.message)} Retrying in ${clockDuration(Math.max(0, event.at - Date.now()))} (${String(event.attempt)}/${String(event.maxAttempts)})`,
          ui.transcript.theme.warning,
        );
        break;
      }
      case "retry_started":
        break;
      case "queued":
        ui.queue.upsert(event.item);
        countQueue();
        break;
      case "queue_consumed":
      case "queue_cancelled":
        ui.queue.resolve(event.entryId);
        countQueue();
        break;
      case "plugins_changed": {
        // Badges and skills can move without the id set moving, so they are
        // re-read on every reactivation; only the note is gated on the set.
        options.onPluginsChanged?.();
        const failed = event.plugins.filter((plugin) => plugin.status === "failed");
        const signature = event.plugins
          .map((plugin) =>
            plugin.status === "failed" ? `${plugin.id}!${plugin.error}` : `${plugin.id}`,
          )
          .join(" ");
        if (signature === lastPluginSignature) break;
        lastPluginSignature = signature;
        runNote(
          `plugins: ${String(event.plugins.length - failed.length)} active${failed.length === 0 ? "" : `, ${String(failed.length)} failed`}`,
          failed.length === 0 ? undefined : ui.transcript.theme.error,
        );
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
      case "name_changed":
        ui.renderer.setTerminalTitle(terminalTitle(event.name));
        break;
      // The branch watcher draws durable entries; run bookkeeping needs no
      // row. A waiting run's question is already on screen as its pending
      // tool call, and the composer is how it gets answered.
      case "head_moved":
      case "claim":
      case "compaction":
        break;
      case "run_waiting": {
        // Render the ask from the event alone; the composer answers it.
        const { question, options } = questionAskFrom(event.args);
        if (question !== undefined) {
          const lines = [
            question,
            ...options.map(
              (option, index) =>
                `  ${String(index + 1)}. ${option.label}${option.description === undefined ? "" : ` - ${option.description}`}`,
            ),
            "Reply with a number, a label, or your own answer. Esc dismisses.",
          ];
          notice(ui, lines.join("\n"));
        }
        break;
      }
      case "synced":
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  });
  // The cold read; from here the queue follows its events.
  void host.sdk.messages
    .pending({ sessionId: host.sessionId })
    .then((items) => {
      if (!isVisible()) return;
      ui.queue.sync(items);
      countQueue();
    })
    .catch(() => undefined);
  refreshUsage();
  return unsubscribe;
}

function openAuthUrl(ui: Ui, input: string): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    notice(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    notice(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
    return;
  }
  void open(url.toString()).catch(() => {
    notice(ui, "Couldn't open URL. Copy to browser.", ui.transcript.theme.error);
  });
}

function userPromptHistory(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const text = partsText(entry.message.content);
    return text.trim() === "" ? [] : [text];
  });
}

async function chooseTrustedWorkspace(
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
        if (prompt.type === "secret" && ui.input.plainText !== "") {
          reject(new Error("Clear the composer before entering a secret"));
          return;
        }
        notice(ui, prompt.message, ui.transcript.theme.foreground);
        ui.input.placeholder = prompt.placeholder ?? "";
        const previousPrompt = ui.prompt.content;
        const previousSubmit = ui.input.onSubmit;
        ui.prompt.content = prompt.type === "secret" ? "key > " : "login > ";
        ui.inputMode = "auth";
        const reveal = prompt.type === "secret" ? concealComposerInput(ui) : undefined;
        let settled = false;
        const finish = (): void => {
          promptSignal.removeEventListener("abort", onAbort);
          ui.input.placeholder = COMPOSER_PLACEHOLDER;
          ui.prompt.content = previousPrompt;
          reveal?.();
          ui.inputMode = "chat";
          ui.input.onSubmit = previousSubmit;
        };
        const onEnter = (): void => {
          if (settled) return;
          settled = true;
          const value = ui.input.plainText;
          ui.input.clear();
          finish();
          notice(ui, prompt.type === "secret" ? "→ ●●●" : `→ ${value}`);
          resolve(value);
        };
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          if (prompt.type === "secret") ui.input.clear();
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
          notice(
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
          notice(ui, `Enter code: ${event.userCode}`, ui.transcript.theme.ok);
          break;
        case "info":
        case "progress":
          notice(ui, event.message);
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
  const previousHints = ui.hintText;
  const onKeyPress = (key: { name: string; ctrl: boolean }): void => {
    if (key.ctrl && key.name === "c") controller.abort();
  };
  ui.renderer.keyInput.on("keypress", onKeyPress);
  ui.authenticating = true;
  try {
    notice(ui, `Logging in to ${provider.name}…`, ui.transcript.theme.tool);
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
    notice(ui, `Logged in to ${provider.name}`, ui.transcript.theme.ok);
    return { models, provider: requireProvider(models, provider.id) };
  } finally {
    ui.authenticating = false;
    setHints(ui, previousHints);
    ui.renderer.keyInput.off("keypress", onKeyPress);
  }
}

/** The user turns on a branch, oldest first: the only entries that can be edited. */
function userMessageEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
}

const THEME_CHOICES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const satisfies readonly Choice[];

/** pi's "Summarize branch?" answers, in its order. */
const SUMMARY_CHOICES: readonly Choice[] = [
  { id: "none", label: "No summary", description: "Leave the branch as it is" },
  { id: "summarize", label: "Summarize", description: "Keep what the branch was about" },
  {
    id: "custom",
    label: "Summarize with custom prompt",
    description: "Say what the summary should focus on",
  },
];

interface OpenTreeOptions {
  /** Rows to show first; the tree's default hides tool results and bookkeeping. */
  readonly filter?: TreeFilter;
  /** Row to highlight; defaults to the head's leaf. */
  readonly selectedId?: string;
}

interface CommandContext {
  getHost: () => UjiHost;
  getRuntime: () => ResolvedRuntime;
  getThemeMode: () => ThemeMode;
  getTrustedWorkspace: () => Promise<TrustedWorkspace>;
  switchRuntime: (runtime: ResolvedRuntime, model: string) => Promise<void>;
  changeDirectory: (directory: string) => Promise<void>;
  changeThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  changeTheme: (mode: ThemeMode) => Promise<void>;
  refreshPluginState: () => Promise<void>;
  rerenderTranscript: () => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  nameSession: (name: string) => Promise<void>;
  nameFromThread: () => Promise<string | undefined>;
  openCommandPalette: () => Promise<void>;
  openSettings: () => Promise<void>;
  openSkillPalette: () => Promise<void>;
  /** The session tree: pick an entry, answer the summary question, move the head. */
  openTree: (options: OpenTreeOptions) => Promise<void>;
  shutdown: () => Promise<void>;
}

const slashCommandCache = new WeakMap<
  UjiHost,
  {
    pluginCommands: UjiHost["commands"];
    skills: UjiHost["skills"];
    projected: SlashCommand[];
  }
>();

function slashCommandsForHost(host: UjiHost): SlashCommand[] {
  const pluginCommands = host.commands;
  const skills = host.skills;
  const cached = slashCommandCache.get(host);
  if (cached?.pluginCommands === pluginCommands && cached.skills === skills) {
    return cached.projected;
  }
  const projected = availableSlashCommands(pluginCommands, skills);
  slashCommandCache.set(host, { pluginCommands, skills, projected });
  return projected;
}

type SlashCommandTarget =
  | { kind: "builtin"; command: NonNullable<ReturnType<typeof resolveSlashCommand>> }
  | { kind: "plugin" }
  | { kind: "skill"; skill: Skill }
  | { kind: "message" };

/** Resolve the current host's namespace once, before the composer decides how to submit. */
function resolveSlashCommandTarget(host: UjiHost, name: string): SlashCommandTarget {
  const command = resolveSlashCommand(name);
  if (command !== undefined) return { kind: "builtin", command };
  if (host.commands.has(name)) return { kind: "plugin" };
  const skill = host.skills.get(name);
  return skill === undefined ? { kind: "message" } : { kind: "skill", skill };
}

/** Badges from plugin settings: each setting's current choice contributes its `status`, if any. */
async function activeSettingBadges(
  host: UjiHost,
): Promise<ReadonlyMap<string, { label: string; status: string }>> {
  const badges = new Map<string, { label: string; status: string }>();
  for (const setting of await host.sdk.plugins.settings.list({ sessionId: host.sessionId })) {
    const status = setting.choices.find((choice) => choice.id === setting.current)?.status;
    if (status !== undefined) badges.set(setting.id, { label: setting.label, status });
  }
  return badges;
}

async function settingStatuses(host: UjiHost): Promise<readonly string[]> {
  return [...(await activeSettingBadges(host)).values()].map((badge) => badge.status);
}

async function activateLoggedInRuntime({
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

type ProviderPickerPurpose = "login" | "logout" | "switch";

function providerPickerChoices({
  models,
  statuses,
  purpose,
}: {
  models: Models;
  statuses: readonly ProviderAuthStatus[];
  purpose: ProviderPickerPurpose;
}): Choice[] {
  const ordered = statuses.toSorted(
    (left, right) => Number(right.kind === "authenticated") - Number(left.kind === "authenticated"),
  );
  const choices: Choice[] = [];
  for (const status of ordered) {
    const { provider } = status;
    const count = models.getModels(provider.id).length;
    const detail =
      purpose !== "switch" || count === 0
        ? provider.id
        : `${provider.id} · default ${defaultModel(models, provider.id).id}`;
    const connection: Choice["status"] =
      status.kind === "authenticated"
        ? {
            text: `logged in${status.auth.source === undefined ? "" : ` via ${status.auth.source}`}`,
            tone: "ok",
          }
        : { text: "not logged in", tone: "dim" };
    choices.push({
      id: provider.id,
      label: provider.name,
      description: detail,
      status: connection,
    });
  }
  return choices;
}

async function pickProvider({
  ui,
  models,
  purpose,
  selectedId,
}: {
  ui: Ui;
  models: Models;
  purpose: ProviderPickerPurpose;
  selectedId?: string;
}): Promise<Provider> {
  const choices = providerPickerChoices({
    models,
    statuses: await providerAuthStatuses(models),
    purpose,
  });
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
    return { models, provider: requireProvider(models, provider.id) };
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
  return { models: current.models, provider };
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

/** The question tool's args, if this waiting call is one; empty otherwise. */
function questionAskFrom(args: JsonValue): {
  question?: string;
  options: { label: string; description?: string }[];
} {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { options: [] };
  const question = typeof args.question === "string" ? args.question : undefined;
  const options = Array.isArray(args.options)
    ? args.options.flatMap((option) => {
        if (typeof option !== "object" || option === null || Array.isArray(option)) return [];
        if (typeof option.label !== "string") return [];
        return [
          {
            label: option.label,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          },
        ];
      })
    : [];
  return question === undefined ? { options: [] } : { question, options };
}

async function runCommand(
  ui: Ui,
  context: CommandContext,
  parsed: ParsedSlashCommand,
  options: {
    delivery?: "steer" | "queue";
    target?: SlashCommandTarget;
  } = {},
): Promise<void> {
  const host = context.getHost();
  const delivery = options.delivery ?? "steer";
  const target = options.target ?? resolveSlashCommandTarget(host, parsed.name);
  const sendAsMessage = async (): Promise<void> => {
    await host.sdk.messages.send({
      sessionId: host.sessionId,
      content: `/${parsed.name}${parsed.argument === "" ? "" : ` ${parsed.argument}`}`,
      delivery,
    });
  };

  switch (target.kind) {
    case "plugin": {
      const outcome = await host.sdk.plugins.commands.run({
        sessionId: host.sessionId,
        name: parsed.name,
        argument: parsed.argument,
      });
      await context.refreshPluginState();
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind === "ran" && outcome.output !== undefined) notice(ui, outcome.output);
      if (outcome.kind === "not_found") await sendAsMessage();
      return;
    }
    case "skill":
      // pi's agent-session pattern: expand the skill to its invocation text,
      // then admit it like chat input so it steers or queues while a run is
      // active instead of failing with "a run is already active". A queued
      // invocation shows up through core's queue events like any other.
      await host.sdk.messages.send({
        sessionId: host.sessionId,
        content: formatSkillInvocation(
          target.skill,
          parsed.argument === "" ? undefined : parsed.argument,
        ),
        delivery,
      });
      return;
    case "message":
      // A contribution can disappear after autocomplete selected it. Treat the
      // unresolved invocation as chat text instead of dropping the submission.
      await sendAsMessage();
      return;
    case "builtin":
      break;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }

  const command = target.command.name;
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
    const currentId = host.sessionId;
    const sessions: Choice[] = [];
    const { items } = await host.sdk.sessions.list();
    for (const session of [...items].reverse()) {
      if (session.heads[0]?.entryId === null) continue;
      const label = session.name ?? shortId(session.sessionId);
      sessions.push({
        id: session.sessionId,
        label: `${label}${session.sessionId === currentId ? " (current)" : ""}`,
        description: `${new Date(session.createdAt).toLocaleString()} · ${shortId(session.sessionId)}`,
      });
    }
    if (sessions.length === 0) {
      notice(ui, "No saved chats");
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

  if (command === "settings") {
    if (argument !== "") throw new Error("/settings takes no argument");
    await context.openSettings();
    return;
  }

  if (command === "theme") {
    if (argument !== "") throw new Error("/theme opens the theme picker and takes no argument");
    if (host.state.busy) throw new Error("Wait for the current operation before changing theme");
    const selected = await selectChoice(ui, "Theme", THEME_CHOICES, {
      selectedId: context.getThemeMode(),
    });
    const mode = THEME_CHOICES.find((choice) => choice.id === selected)?.id;
    if (mode === undefined) throw new Error("Theme is no longer available");
    await context.changeTheme(mode);
    return;
  }

  if (command === "name") {
    if (argument === "") {
      notice(ui, "Usage: /name <chat name>", ui.transcript.theme.error);
      return;
    }
    await context.nameSession(argument);
    return;
  }

  if (command === "title") {
    if (argument !== "") {
      throw new Error("/title takes no argument. /name <name> sets one by hand");
    }
    const title = await context.nameFromThread();
    if (title !== undefined) notice(ui, `Chat named ${title}`, ui.transcript.theme.ok);
    return;
  }

  if (command === "login") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before logging in");
    }
    const current = context.getRuntime();
    const models = current.models;
    const provider =
      argument === ""
        ? await pickProvider({
            ui,
            models,
            purpose: "login",
            selectedId: current.provider.id,
          })
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
    if (host.state.busy) {
      throw new Error("Wait for the current operation before logging out");
    }
    const current = context.getRuntime();
    const provider =
      argument === ""
        ? await pickProvider({
            ui,
            models: current.models,
            purpose: "logout",
            selectedId: current.provider.id,
          })
        : requireProvider(current.models, argument);
    await current.models.logout(provider.id);
    notice(ui, `Logged out of ${provider.name}`, ui.transcript.theme.ok);
    return;
  }

  if (command === "compact") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before compacting");
    }
    const outcome = await host.sdk.runs.compact({
      sessionId: host.sessionId,
      ...(argument === "" ? {} : { customInstructions: argument }),
    });
    if (outcome.kind === "nothing_to_compact") {
      notice(ui, "Nothing to compact");
      return;
    }
    if (outcome.kind === "failed") throw new Error(outcome.message);
    return;
  }

  if (command === "usage") {
    if (argument !== "") throw new Error("/usage takes no argument");
    // Durable numbers open at once over what this host has already observed.
    const report = await collectWorkspaceUsage(host.store, host.sessionId);
    const activeProvider = host.model.provider;
    const refreshing = host.shouldRefreshAccountLimits();
    const panel = openUsageCard(
      ui,
      usageCard(report, host.cachedAccountLimits(), { activeProvider, refreshing }),
    );
    if (refreshing) {
      void host.accountLimits().then(
        (limits) => {
          if (panel.destroyed) return;
          panel.show(usageCard(report, limits, { activeProvider, refreshing: false }));
        },
        () => {
          if (panel.destroyed) return;
          panel.show(
            usageCard(report, host.cachedAccountLimits(), { activeProvider, refreshing: false }),
          );
        },
      );
    }
    return;
  }

  if (command === "provider") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before switching provider");
    }
    const current = context.getRuntime();
    const provider =
      argument === ""
        ? await pickProvider({
            ui,
            models: current.models,
            purpose: "switch",
            selectedId: current.provider.id,
          })
        : requireProvider(current.models, argument);
    if (provider.id === current.provider.id) {
      notice(ui, `Already using ${provider.name}`);
      return;
    }
    const runtime = await runtimeForProvider(ui, current.models, provider);
    if (runtime === undefined) throw new Error(`Couldn't log in to ${provider.name}`);
    await context.switchRuntime(runtime, defaultModel(runtime.models, provider.id).id);
    return;
  }

  if (command === "model") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before switching model");
    }
    const currentRuntime = context.getRuntime();
    const currentModel = host.model.id;
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
      notice(ui, `Already using ${selectedModel.provider}/${selectedModel.id}`);
      return;
    }
    const nextRuntime = await runtimeForModel(currentRuntime, selectedModel);
    await context.switchRuntime(nextRuntime, selectedModel.id);
    return;
  }

  if (command === "effort") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before changing thinking level");
    }
    const levels = getSupportedThinkingLevels(host.model);
    const selected =
      argument === ""
        ? await selectChoice(
            ui,
            "Thinking level",
            levels.map((level) => ({ id: level, label: level })),
            { selectedId: host.thinkingLevel },
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
      notice(ui, "Usage: /cd <directory>", ui.transcript.theme.error);
      return;
    }
    await context.changeDirectory(argument);
    return;
  }

  if (command === "tree") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before changing the session branch");
    }
    if (argument !== "") throw new Error("/tree opens the session tree and takes no argument");
    await context.openTree({});
    return;
  }

  if (command === "edit") {
    if (host.state.busy) {
      throw new Error("Wait for the current operation before changing message history");
    }
    if (argument !== "") throw new Error("/edit opens the message picker and takes no argument");
    await context.openTree({ filter: "users" });
    return;
  }

  if (command === "plugins") {
    if (argument !== "") throw new Error("/plugins takes no argument");
    await notePlugins(ui, host);
    return;
  }

  if (command === "reload") {
    if (argument !== "") throw new Error("/reload takes no argument");
    if (host.state.busy) throw new Error("Wait for the current operation before reloading");
    await host.reloadPlugins(await context.getTrustedWorkspace());
    await context.rerenderTranscript();
    await noteReloaded(ui, host);
    return;
  }

  if (command === "update") {
    const outcome = await selfUpdate({
      ...(argument === "" ? {} : { version: argument }),
      // A transcript note cannot rewrite itself, so percent events are dropped
      // rather than stacking ten rows under one download.
      report: (event) => {
        if (event.kind === "downloading") notice(ui, `Downloading ${event.asset}…`);
        else if (event.kind === "verified") notice(ui, "Checksum verified.");
      },
    });
    const noteColor: Record<Severity, string | undefined> = {
      ok: undefined,
      warn: ui.transcript.theme.warning,
      fail: ui.transcript.theme.error,
    };
    notice(ui, describeUpdateOutcome(outcome), noteColor[updateSeverity(outcome)]);
    return;
  }

  if (command === "skills") {
    if (argument !== "") throw new Error("/skills opens the skill palette and takes no argument");
    await context.openSkillPalette();
    return;
  }

  command satisfies never;
}

function noteSkillsLoaded(ui: Ui, host: UjiHost): void {
  const count = host.skills.size;
  notice(ui, `${String(count)} ${count === 1 ? "skill" : "skills"} loaded`);
}

async function noteReloaded(ui: Ui, host: UjiHost): Promise<void> {
  const pluginCount = (await host.sdk.plugins.list({ sessionId: host.sessionId })).length;
  const skillCount = host.skills.size;
  notice(
    ui,
    `Reloaded ${String(pluginCount)} ${pluginCount === 1 ? "plugin" : "plugins"} and ${String(skillCount)} ${skillCount === 1 ? "skill" : "skills"}, then redrew the chat`,
    ui.transcript.theme.ok,
  );
}

async function notePlugins(ui: Ui, host: UjiHost): Promise<void> {
  const plugins = await host.sdk.plugins.list({ sessionId: host.sessionId });
  if (plugins.length === 0) {
    notice(ui, "No plugins");
    return;
  }
  for (const plugin of plugins) {
    const where = plugin.path === undefined ? plugin.source : `${plugin.source} ${plugin.path}`;
    if (plugin.status === "failed") {
      notice(ui, `${plugin.id} ${where} failed: ${plugin.error}`, ui.transcript.theme.error);
    } else {
      notice(ui, `${plugin.id} ${where}`);
    }
  }
  const commands = [...host.commands.keys()];
  if (commands.length > 0) notice(ui, `Commands: ${commands.map((name) => `/${name}`).join(" ")}`);
}

/** A plugin's question. Confirm and select open the picker; input captures the composer. */

export type TuiExit = { kind: "quit" } | { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

interface RunTuiOptions {
  /** Use an existing renderer when embedding or driving the TUI. */
  renderer?: CliRenderer;
  /** Runs after the session and renderer have closed. */
  onSessionClosed?: (sessionId: SessionId) => void;
}

/** The renderer the binary runs on. */
export function createTuiRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: false,
    enableMouseMovement: true,
    clearOnShutdown: true,
    // Bottom-pinned streaming repaints most of the viewport every time a line
    // wraps, because OpenTUI rewrites cells and never asks the terminal to
    // scroll. The work per second is the same at 30 or 60, but at 60 it lands
    // in half-size steps, which is the difference between a lurch and a slide.
    targetFps: 60,
  });
}

/**
 * Boots the interactive TUI. The renderer defaults to the real terminal. The
 * QA driver passes a renderer so the same boot path can run under scripted
 * keystrokes without writing application output into the test reporter.
 */
export async function runTui(flags: RunFlags, options: RunTuiOptions = {}): Promise<TuiExit> {
  const renderLog = createTuiRenderLog();
  const renderer = options.renderer ?? (await createTuiRenderer());
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
  let themeMode = resolveThemeMode();
  const ui = buildUi(renderer, themeForMode(themeMode));
  ui.transcript.openPath = (path) => {
    void open(path);
  };
  // A notice is the client talking. The next key is the user talking, so the
  // slot goes back to the transcript. Registered before every handler that
  // raises one, so the key that caused a notice never also dismisses it.
  renderer.keyInput.on("keypress", () => ui.ephemeral.release("notice"));
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

    const fallbacks = hostFallbacks(resolvedRuntime, settings, {
      model: flags.model,
      effort: flags.effort,
    });
    const opened = await UjiHost.open(
      {
        workspace: initialWorkspace,
        settings,
        runtime: resolvedRuntime,
        model: fallbacks.model,
        thinkingLevel: fallbacks.thinkingLevel,
        report: (message) => notice(ui, message, ui.transcript.theme.error),
      },
      flags.resume,
    );
    // `/cd` swaps the host for one composed against the next workspace; every
    // closure reads this binding, so the swap is one assignment.
    let host = opened.host;
    /** The launch workspace's store; `/cd` must not strand the chat elsewhere. */
    const storePath = join(initialWorkspace.cwd, ".uji", "sessions.db");
    // Naming is host UX. The old plugin id still configures its prompt or turns it off.
    const naming = await manifestPluginOptions(host.cwd, "session-title");
    const namer = naming.disabled
      ? undefined
      : createChatNamer({
          runtime: () => ({ models: host.runtime.models, primary: host.model }),
          session: () => host.storage,
          ...(naming.options === undefined ? {} : { options: naming.options }),
        });
    if (namer !== undefined) disposers.push(() => namer.dispose());
    ui.transcript.cwd = host.cwd;
    ui.transcript.toolCalls = settings.toolCalls;
    const composerParts = new ComposerParts();
    const sessionDrafts = new SessionDrafts();
    const saveVisibleDraft = (): void => {
      sessionDrafts.save(host.sessionId, ui.input.plainText, composerParts.current);
    };
    const restoreDraft = (sessionId: string): void => {
      const draft = sessionDrafts.read(sessionId);
      composerParts.restore(draft?.parts ?? []);
      setInputText(ui.input, draft?.text ?? "");
    };
    const composerMarkers = new ComposerMarkers({
      renderer,
      input: ui.input,
      preview: ui.composerPreview,
      previewSyntaxStyle: ui.transcript.syntaxStyle,
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
        options.onSessionClosed?.(host.sessionId);
      }
    };
    void checkForUpdate().then(async (release) => {
      if (release === undefined || shutdownStarted) return;
      if (!settings.autoUpdate) {
        notice(
          ui,
          `Update available: ${release.version} · /update to install`,
          ui.transcript.theme.warning,
        );
        return;
      }
      const outcome = await selfUpdate();
      if (shutdownStarted) return;
      if (outcome.kind === "updated") {
        notice(ui, describeUpdateOutcome(outcome));
        return;
      }
      notice(
        ui,
        `Update available: ${release.version} · ${describeUpdateOutcome(outcome)}`,
        ui.transcript.theme.warning,
      );
    });
    /** The whole footer for the active session; the wire's cold read fills the queue. */
    const sessionStatus = async (): Promise<PowerlineState> => ({
      ...(await readWorkspaceStatus(host.cwd)),
      provider: host.model.provider,
      model: host.model.id,
      effort: host.thinkingLevel,
      statuses: await settingStatuses(host),
      queued: 0,
      ...(await usageStatus(host)),
    });
    const status = new ComposerStatus(
      renderer,
      ui.powerline,
      ui.transcript.theme,
      () => ui.input.focused || ui.inputBox.focused,
      await sessionStatus(),
    );
    disposers.push(() => status.dispose());
    // The composer's border swaps color on focus; the rule that closes its
    // frame has to swap with it.
    for (const event of [RenderableEvents.FOCUSED, RenderableEvents.BLURRED]) {
      ui.input.on(event, status.repaint);
      disposers.push(() => ui.input.off(event, status.repaint));
    }
    const refreshPluginState = async (): Promise<void> => {
      status.patch({ statuses: await settingStatuses(host) });
    };
    const rerenderTranscript = async (): Promise<void> => {
      const branch = await host.storage.getBranch("main");
      const open = await host.sdk.runs.current({ sessionId: host.sessionId });
      replaceTranscript(ui, branch, { openLastTurn: open !== undefined });
      renderer.requestRender();
    };
    const changeTheme = async (mode: ThemeMode): Promise<void> => {
      themeMode = mode;
      applyUiTheme(ui, themeForMode(mode));
      composerMarkers.retheme(ui.transcript.syntaxStyle);
      slashAutocomplete.retheme(ui.transcript.theme);
      status.repaint();
      await rerenderTranscript();
      notice(ui, `Theme: ${mode}`, ui.transcript.theme.ok);
    };
    // A watched reload is background work: it earns a line only when the set of
    // skills changed. /reload always reports, because it was asked for.
    let lastSkillCount = host.skills.size;
    const noteSkillsIfMoved = (): void => {
      const count = host.skills.size;
      if (count === lastSkillCount) return;
      lastSkillCount = count;
      noteSkillsLoaded(ui, host);
    };
    let stopSessionWire = (): void => undefined;
    const wireActiveSession = (): void => {
      stopSessionWire();
      renderer.setTerminalTitle(terminalTitle(host.name));
      const wiredHost = host;
      const wiredSessionId = host.sessionId;
      const isVisible = (): boolean => host === wiredHost && host.sessionId === wiredSessionId;
      stopSessionWire = wireSession(ui, wiredHost, {
        status,
        cwd: wiredHost.cwd,
        namer,
        runNotifications: () => settings.runNotifications,
        onPluginsChanged: () => {
          void refreshPluginState();
          noteSkillsIfMoved();
        },
        isVisible,
      });
    };
    wireActiveSession();
    disposers.push(() => stopSessionWire());
    // Saved defaults follow what actually runs: the first run of a session
    // records the provider, model, and effort it started with.
    disposers.push(
      host.subscribe((event) => {
        if (event.kind !== "run_started" || event.operation !== "run") return;
        void settingsStore.updateGlobal({
          defaultProvider: host.runtime.provider.id,
          defaultModel: host.model.id,
          defaultThinkingLevel: host.thinkingLevel,
        });
      }),
    );
    disposers.push(
      watchPluginDirectories({
        directories: [
          ...pluginDirectories(host.cwd),
          ...skillDirectories(host.cwd).map((path) => ({ path })),
        ],
        onChange: async () => {
          await host.reloadPlugins(await trustStore.require(host.cwd));
        },
        onError: (error) =>
          notice(ui, `plugin reload failed: ${error.message}`, ui.transcript.theme.error),
      }),
    );
    const initialBranch = await host.storage.getBranch("main");
    const promptHistory = new PromptHistory();
    promptHistory.replace(userPromptHistory(initialBranch));
    // Keyed on the session: switching restarts the watch there, and a restart
    // would republish the whole branch and redraw the chat for nothing.
    let stopBranchWatch = (): void => undefined;
    const watchActiveBranch = (): void => {
      stopBranchWatch();
      const watched = host.storage;
      const isCurrent = (): boolean => host.storage === watched;
      stopBranchWatch = watchSessionBranch(watched, {
        head: "main",
        // A linear commit folds into the chat in place. The local run's own
        // commits were already drawn under the same identities, so the fold
        // is a no-op for them; a write from another process appends.
        onAppend(entry) {
          if (isCurrent()) commitTranscriptEntry(ui, entry);
        },
        onBranch(entries) {
          if (!isCurrent()) return;
          promptHistory.replace(userPromptHistory(entries));
          if (host.state.busy) return;
          replaceTranscript(ui, entries);
        },
        onError(error) {
          if (isCurrent()) {
            notice(ui, `Session watch failed: ${error.message}`, ui.transcript.theme.error);
          }
        },
      });
    };
    watchActiveBranch();
    disposers.push(() => stopBranchWatch());
    // A name left in the title bar of a shell that outlives uji is a lie.
    disposers.push(() => renderer.setTerminalTitle(TERMINAL_TITLE_BASE));

    const switchRuntime = async (
      nextRuntime: ResolvedRuntime,
      nextModel: string,
    ): Promise<void> => {
      const model = requireCatalogModel(nextRuntime.models, nextRuntime.provider.id, nextModel);
      if (
        host.runtime.provider.id === nextRuntime.provider.id &&
        host.model.id === model.id &&
        host.model.provider === model.provider
      ) {
        notice(ui, `Already using ${nextModel}`);
        return;
      }
      const badgesBefore = await activeSettingBadges(host);
      host.runtime = nextRuntime;
      const outcome = await host.configureModel(model);
      if (outcome === "deferred") notice(ui, `Model changes after this run: ${model.id}`);
      status.patch({
        provider: model.provider,
        model: model.id,
        effort: host.thinkingLevel,
        statuses: await settingStatuses(host),
      });
      settings = {
        ...settings,
        defaultProvider: nextRuntime.provider.id,
        defaultModel: nextModel,
      };
      await settingsStore.updateGlobal({
        defaultProvider: nextRuntime.provider.id,
        defaultModel: nextModel,
      });
      const badgesAfter = await activeSettingBadges(host);
      for (const [id, badge] of badgesBefore) {
        if (!badgesAfter.has(id)) notice(ui, `${badge.label} unavailable for ${nextModel}`);
      }
    };

    const changeDirectory = async (input: string): Promise<void> => {
      if (host.state.busy) {
        throw new Error("Wait for the current operation before changing directory");
      }
      const requested = resolveDirectory(host.cwd, input);
      const info = await stat(requested);
      if (!info.isDirectory()) throw new Error(`Not a directory: ${requested}`);
      const workspace = await chooseTrustedWorkspace(
        ui,
        trustStore,
        requested,
        "cancel",
        undefined,
        renderLog,
      );
      if (workspace === undefined) throw new WorkspaceTrustRequired(requested);
      if (workspace.cwd === host.cwd) {
        notice(ui, `Already in ${host.cwd}`);
        return;
      }
      const nextSettings = await settingsStore.read(workspace.cwd);
      const next = await UjiHost.open(
        {
          workspace,
          settings: nextSettings,
          runtime: host.runtime,
          model: host.model,
          thinkingLevel: host.thinkingLevel,
          storePath,
          report: (message) => notice(ui, message, ui.transcript.theme.error),
        },
        { kind: "session", id: host.sessionId },
      );
      const previous = host;
      host = next.host;
      settings = nextSettings;
      // The cwd_change entry is the durable record; the transcript draws it.
      await host.storage.admitEntry(
        { type: "custom", id: newId("e"), customType: "cwd_change", data: { cwd: workspace.cwd } },
        "main",
      );
      rewireActiveSession();
      void previous.parkAndClose();
      ui.transcript.cwd = host.cwd;
      ui.transcript.toolCalls = settings.toolCalls;
      status.patch(await readWorkspaceStatus(host.cwd));
      await refreshMentionFiles(host.cwd);
    };

    const changeThinkingLevel = async (level: ThinkingLevel, announce = true): Promise<void> => {
      if (host.thinkingLevel === level) {
        if (announce) notice(ui, `Already using ${level}`);
        return;
      }
      const outcome = await host.configureThinking(level);
      if (outcome === "deferred") notice(ui, `Thinking level changes after this run: ${level}`);
      status.patch({ effort: host.thinkingLevel });
      settings = { ...settings, defaultThinkingLevel: level };
      await settingsStore.updateGlobal({ defaultThinkingLevel: level });
      if (announce) notice(ui, `Thinking level: ${level}`, ui.transcript.theme.ok);
    };

    /**
     * Everything keyed to the active session, restarted after a session or
     * workspace switch: the wire (which carries the title) and the branch fold.
     * `attach()` inside the host already resumes an orphaned operation and
     * follows a live claim without contesting it (design record, "Who runs?").
     */
    const rewireActiveSession = (): void => {
      wireActiveSession();
      watchActiveBranch();
    };

    /**
     * Compaction and transport are composition inputs, so changing one
     * recomposes: a fresh host over the same workspace, store, and session.
     * Cheap and rare; the alternative is a mutable register the SDK refuses.
     */
    const reopenWithSettings = async (next: ResolvedSettings): Promise<void> => {
      if (host.state.busy) {
        throw new Error("Wait for the current operation before changing settings");
      }
      const workspace = await trustStore.require(host.cwd);
      const previous = host;
      const replacement = await UjiHost.open(
        {
          workspace,
          settings: next,
          runtime: host.runtime,
          model: host.model,
          thinkingLevel: host.thinkingLevel,
          storePath,
          report: (message) => notice(ui, message, ui.transcript.theme.error),
        },
        { kind: "session", id: host.sessionId },
      );
      host = replacement.host;
      settings = next;
      rewireActiveSession();
      void previous.parkAndClose();
    };
    const showSession = async ({
      sessionId,
      announce,
    }: {
      sessionId: string;
      announce: boolean;
    }): Promise<void> => {
      restoreDraft(sessionId);
      ui.input.placeholder = COMPOSER_PLACEHOLDER;
      ui.focus.reset();
      refreshHints(ui, host.state.busy);
      const branch = await host.storage.getBranch("main");
      ui.transcript.cwd = host.cwd;
      ui.transcript.toolCalls = settings.toolCalls;
      // An open operation means a run is live here or resumable by attach.
      const open = await host.sdk.runs.current({ sessionId: host.sessionId });
      replaceTranscript(ui, branch, { openLastTurn: open !== undefined });
      promptHistory.replace(userPromptHistory(branch));
      status.replace(await sessionStatus());
      if (announce) {
        turnNote(ui, `Resumed ${shortId(sessionId)} · ${String(branch.length)} entries`);
      }
      if (open?.kind === "orphaned") {
        turnNote(ui, "Resuming…", ui.transcript.theme.tool);
      } else if (open?.kind === "live") {
        notice(ui, "Another uji is running this chat; following along.");
      }
    };

    let switchingSession = false;
    const resumeSession = async (nextSessionId: string): Promise<void> => {
      if (nextSessionId === host.sessionId) {
        notice(ui, `Already in ${shortId(nextSessionId)}`);
        return;
      }
      if (switchingSession) throw new Error("A chat switch is already in progress");
      switchingSession = true;
      try {
        saveVisibleDraft();
        await host.activateSession(parseSessionId(nextSessionId));
        rewireActiveSession();
        await showSession({ sessionId: nextSessionId, announce: true });
      } finally {
        switchingSession = false;
      }
    };

    const newSession = async (): Promise<void> => {
      saveVisibleDraft();
      const info = await host.newSession();
      rewireActiveSession();
      await showSession({ sessionId: info.sessionId, announce: false });
    };

    const nameSession = async (name: string): Promise<void> => {
      await host.sdk.sessions.rename({ sessionId: host.sessionId, name });
      notice(ui, `Chat named ${name}`, ui.transcript.theme.ok);
    };

    let commandContext: CommandContext;

    const openSettings = async (): Promise<void> => {
      if (host.state.busy) {
        throw new Error("Wait for the current operation before changing settings");
      }
      if (ui.selecting) throw new Error("Another menu is already open");

      // One resolved snapshot: current() runs during a sync render, and applying
      // writes durable storage, so the row patches its own copy afterwards.
      const pluginSettings = await host.sdk.plugins.settings.list({ sessionId: host.sessionId });
      const settingValues = new Map(pluginSettings.map((setting) => [setting.id, setting.current]));
      const pluginRows = pluginSettings.map((setting): SettingRow => ({
        id: `plugin:${setting.id}`,
        label: setting.label,
        current: () => settingValues.get(setting.id) ?? setting.choices[0].id,
        choices: () =>
          setting.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.description === undefined ? {} : { description: choice.description }),
          })),
        apply: async (choiceId) => {
          const outcome = await host.sdk.plugins.settings.apply({
            sessionId: host.sessionId,
            id: setting.id,
            choiceId,
          });
          if (outcome.kind !== "applied") throw new Error(`Could not set ${setting.label}`);
          settingValues.set(setting.id, choiceId);
          await refreshPluginState();
        },
      }));

      const rows: readonly SettingRow[] = [
        {
          id: "model",
          label: "Model",
          current: () => `${host.runtime.provider.id}/${host.model.id}`,
          choices: () => cachedModelChoices(host.runtime.models),
          load: () => reloadModelChoices(host.runtime.models),
          apply: (choiceId) => switchToModelChoice(host.runtime, choiceId, switchRuntime),
        },
        {
          id: "thinking",
          label: "Thinking level",
          current: () => host.thinkingLevel,
          choices: () =>
            getSupportedThinkingLevels(host.model).map((level) => ({
              id: level,
              label: level,
            })),
          apply: async (choiceId) => {
            const level = getSupportedThinkingLevels(host.model).find(
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
            await reopenWithSettings({ ...settings, compaction });
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
            settings = { ...settings, autoUpdate };
            await settingsStore.updateGlobal({ autoUpdate });
          },
        },
        {
          id: "run-notifications",
          label: "Run alerts",
          current: () => settings.runNotifications,
          choices: () => [
            { id: "alert", label: "alert", description: "Show an alert when each run stops" },
            {
              id: "sound",
              label: "alert + sound",
              description: "Show the alert and ring the terminal bell",
            },
            { id: "off", label: "off", description: "Don't alert when runs stop" },
          ],
          apply: async (choiceId) => {
            const runNotifications = RUN_NOTIFICATION_MODES.find(
              (candidate) => candidate === choiceId,
            );
            if (runNotifications === undefined) {
              throw new Error(`Unknown run alert mode: ${choiceId}`);
            }
            settings = { ...settings, runNotifications };
            await settingsStore.updateGlobal({ runNotifications });
          },
        },
        {
          id: "tool-calls",
          label: "Tool calls",
          current: () => settings.toolCalls,
          choices: () => [
            {
              id: "auto",
              label: "auto",
              description: "Group consecutive calls; edits stay full cards",
            },
            { id: "compact", label: "compact", description: "Group every call, edits included" },
            { id: "detailed", label: "detailed", description: "One full card per call" },
          ],
          apply: async (choiceId) => {
            const toolCalls = TOOL_CALL_DISPLAY_MODES.find((candidate) => candidate === choiceId);
            if (toolCalls === undefined) throw new Error(`Unknown tool call display: ${choiceId}`);
            settings = { ...settings, toolCalls };
            ui.transcript.toolCalls = toolCalls;
            // Presentation only, so redraw the record instead of recomposing
            // the host. The menu opens while idle, which makes this safe.
            await rerenderTranscript();
            await settingsStore.updateGlobal({ toolCalls });
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
            await reopenWithSettings({ ...settings, transport });
            await settingsStore.updateGlobal({ transport });
          },
        },
        ...pluginRows,
      ];

      return new Promise<void>((resolve) => {
        const close = (): void => {
          closeInlineMenu(ui, menu);
          refreshHints(ui, host.state.busy);
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
      const commands = availableSlashCommands(host.commands, new Map());
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
          prefillComposer(acceptance.token);
          return;
        }
      }
      await runCommand(ui, commandContext, { name: selected.name, argument: "" });
    };

    const openSkillPalette = async (): Promise<void> => {
      const items = skillPaletteItems(host.skills);
      if (items.length === 0) {
        notice(ui, "No skills found. Add SKILL.md to .uji/skills.");
        return;
      }
      const selectedName = await selectChoice(ui, "Skills", items);
      prefillComposer(`/${selectedName} `);
    };

    const focusComposer = (): void => {
      ui.focus.reset();
      refreshHints(ui, host.state.busy);
    };
    const clearComposer = (): void => {
      composerParts.clear();
      promptHistory.resetBrowse();
      ui.input.clear();
      focusComposer();
    };

    const requireEditableHistory = (): void => {
      if (host.state.busy) {
        throw new Error("Wait for the current operation before changing message history");
      }
    };

    /** Put a message that just left the record into the composer, files and all. */
    const handBackMessage = (sent: UserMessage, told: string): void => {
      setInputText(ui.input, composerParts.load(sent.content));
      promptHistory.resetBrowse();
      focusComposer();
      notice(ui, told, ui.transcript.theme.ok);
    };

    /**
     * pi's "Summarize branch?" question. Escape hands the tree back; cancelling
     * the focus text asks the question again.
     */
    const askSummary = async (): Promise<
      { kind: "chosen"; summary?: { customInstructions?: string } } | { kind: "back" }
    > => {
      while (true) {
        let choice: string;
        try {
          choice = await selectChoice(ui, "Summarize the branch you are leaving?", SUMMARY_CHOICES);
        } catch (error) {
          if (error instanceof PickerCancelled) return { kind: "back" };
          throw error;
        }
        if (choice === "none") return { kind: "chosen" };
        if (choice === "summarize") return { kind: "chosen", summary: {} };
        notice(ui, "What should the summary focus on?", ui.transcript.theme.foreground);
        try {
          const focus = await readComposerLine(ui, () => host.state.busy, {
            prompt: "focus > ",
            placeholder: "the failing test, the approach that was dropped…",
          });
          return {
            kind: "chosen",
            summary: focus.trim() === "" ? {} : { customInstructions: focus.trim() },
          };
        } catch (error) {
          if (!(error instanceof PickerCancelled)) throw error;
        }
      }
    };

    /**
     * The tree, the summary question, and the move, in pi's order. Core
     * re-points the head as a durable run; this only asks. Landing on a message
     * you sent takes it back instead of parking under it: the head parks on
     * its parent and the message returns to the composer with its files and
     * images still attached, which is the only way to edit what you already
     * said. Any other entry becomes the leaf. Escape in the question and a
     * stopped summary both reopen the tree on the same row; a failed summary
     * leaves the head where it was.
     *
     * Based on pi's `showTreeSelector` and `navigateTree`:
     * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5175
     * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts#L3030
     */
    const openTree = async (options: OpenTreeOptions): Promise<void> => {
      requireEditableHistory();
      const entries = await host.storage.findEntries();
      if (entries.length === 0) {
        notice(ui, "No messages to branch from");
        return;
      }
      const leafId = await host.storage.getLeafId("main");
      const selectedId = await selectTreeEntry(ui, {
        tree: projectSessionTree(entries, leafId),
        selectedId: options.selectedId ?? leafId,
        ...(options.filter === undefined ? {} : { filter: options.filter }),
      });
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const selected = byId.get(selectedId);
      if (selected === undefined) throw new Error(`Entry not found: ${selectedId}`);
      const target = navigationTarget(selected);
      if (target.kind === "move" && target.targetId === leafId) {
        notice(ui, "Already at that point in the chat");
        return;
      }
      const takesBack = target.kind === "restore";
      // Holding the returning message would mean overwriting the draft already
      // in the composer, so refuse instead of choosing which text to lose.
      if (takesBack && ui.input.plainText.trim() !== "") {
        throw new Error("Clear the composer before editing a message");
      }
      const again = (): Promise<void> => openTree({ ...options, selectedId });
      let summary: { customInstructions?: string } | undefined;
      if (collectAbandonedEntries(byId, leafId, selectedId).entries.length > 0) {
        const answer = await askSummary();
        if (answer.kind === "back") return again();
        summary = answer.summary;
      }
      // The pickers were open for as long as the user took to read them.
      requireEditableHistory();
      const outcome = await host.sdk.heads.move({
        sessionId: host.sessionId,
        to: selectedId,
        ...(summary === undefined ? {} : { summary }),
      });
      if (outcome.kind === "not_found") throw new Error(`Entry not found: ${selectedId}`);
      if (outcome.kind === "busy") throw new Error("Wait for the current operation");
      if (outcome.kind === "aborted") {
        notice(ui, "Branch summary stopped");
        return again();
      }
      if (outcome.kind === "failed") throw new Error(outcome.message);
      // Match pi's navigation order: redraw the destination before a restored
      // message reaches the composer, where it can be submitted immediately.
      const branch = await host.storage.getBranch("main");
      promptHistory.replace(userPromptHistory(branch));
      replaceTranscript(ui, branch);
      if (outcome.restored !== undefined) {
        handBackMessage(
          { role: "user", content: outcome.restored.content, timestamp: Date.now() },
          "Message moved back to the composer. Enter sends it again.",
        );
        return;
      }
      const movedTo = await host.storage.getLeafId("main");
      notice(
        ui,
        movedTo === null
          ? "Moved to the start of the chat. The next message starts a branch."
          : `Moved to ${shortId(movedTo)}. The next message starts a branch.`,
        ui.transcript.theme.ok,
      );
      focusComposer();
    };

    /**
     * Escape stopped the run before the model said anything, so the message
     * goes back where it was typed rather than sitting under a stopped line.
     * It is `openTree` on the last thing you sent, minus the picker and the
     * summary question: nothing was abandoned, because nothing was produced.
     *
     * Waiting for idle first is not optional. The runner still holds the head
     * when `run_finished` arrives, and `navigate` would queue behind that claim
     * rather than fail, which is a slower way to reach the same place.
     */
    const retractStoppedPrompt = async (): Promise<void> => {
      await host.sdk.runs.wait({ sessionId: host.sessionId });
      const branch = await host.storage.getBranch("main");
      const sent = userMessageEntries(branch).at(-1);
      const restore = sent === undefined ? undefined : await navigateBack(sent.id);
      // The turn is already off screen, so a chat that cannot give the message
      // back has to redraw itself rather than stay a message short.
      if (restore === undefined) {
        replaceTranscript(ui, await host.storage.getBranch("main"));
        return;
      }
      handBackMessage(restore, "Stopped. Message is back in the composer.");
    };

    /** Park the head on an entry's parent and return the message it held. */
    const navigateBack = async (entryId: string): Promise<UserMessage | undefined> => {
      const outcome = await host.sdk.heads.move({ sessionId: host.sessionId, to: entryId });
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind === "busy") throw new Error("Wait for the current operation");
      if (outcome.kind !== "moved" || outcome.restored === undefined) return undefined;
      return { role: "user", content: outcome.restored.content, timestamp: Date.now() };
    };

    ui.retractPrompt = () => {
      void retractStoppedPrompt().catch(reportCommandError);
      return true;
    };

    commandContext = {
      getHost: () => host,
      getRuntime: () => host.runtime,
      getThemeMode: () => themeMode,
      getTrustedWorkspace: () => trustStore.require(host.cwd),

      switchRuntime,
      changeDirectory,
      changeThinkingLevel,
      changeTheme,
      refreshPluginState,
      rerenderTranscript,
      resumeSession,
      newSession,
      nameSession,
      nameFromThread: () => {
        if (namer === undefined) {
          throw new Error('Chat naming is disabled ("-session-title" in .uji/uji.json)');
        }
        return namer.nameNow();
      },
      openCommandPalette,
      openSettings,
      openSkillPalette,
      openTree,
      shutdown,
    };

    const reportCommandError = (error: unknown): void => {
      if (error instanceof PickerCancelled) return;
      // A command still in flight when /quit closes the SDK fails with
      // UjiClosed; there is no screen left to report that on.
      if (shutdownStarted) return;
      notice(ui, `error: ${errorMessage(error)}`, ui.transcript.theme.error);
    };

    /**
     * Queued messages are reviewed the way opencode reviews them: one keyboard
     * menu over the composer, no pane and no mouse targets. Every action ends
     * the menu, so the composer is never left half-owned by a list. Enter and
     * ctrl+e take a message back to the composer, ctrl+d drops it.
     *
     * Based on opencode's queued-prompt panel:
     * https://github.com/anomalyco/opencode/blob/3a31c4ea801915c0b050df4b3842997ea62b6e93/packages/opencode/src/cli/cmd/run/footer.command.tsx
     */
    const takeQueued = async (entryId: string): Promise<boolean> => {
      const outcome = await host.sdk.messages.cancel({ sessionId: host.sessionId, entryId });
      if (outcome.kind === "cancelled") return true;
      // Core sent it between the menu opening and the key: it is in the
      // transcript now, so there is nothing left to take back.
      notice(ui, "That message was already sent", ui.transcript.theme.warning);
      return false;
    };

    const deleteQueued = async (entryId: string): Promise<void> => {
      if (await takeQueued(entryId)) notice(ui, "Removed from the queue");
    };

    /**
     * Send the message at the front of the queue now, without taking it back
     * to the composer first. Core keeps the same entry and the same place in
     * line; only the lane changes, so a follow-up joins the run instead of
     * waiting it out.
     *
     * Based on OpenCode v2, where the queued-prompt menu makes steer the
     * default action on a waiting message:
     * https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/routes/session/index.tsx
     */
    const steerQueued = async (entryId: string): Promise<void> => {
      const outcome = await host.sdk.messages.redeliver({
        sessionId: host.sessionId,
        entryId,
        delivery: "steer",
      });
      // Every non-moved outcome means the queue moved under the menu, and each
      // is already what the key was for: the message is gone or on its way.
      if (outcome.kind === "unchanged") {
        notice(ui, `That message is already going out with the next step`);
        return;
      }
      if (outcome.kind === "already_consumed" || outcome.kind === "not_found") {
        notice(ui, "That message was already sent", ui.transcript.theme.warning);
      }
    };

    /**
     * Enter on an empty composer sends what is already waiting. There is
     * nothing to submit, and the one thing a queue makes you want is for the
     * next message to go now, so the empty keystroke is spent on that instead
     * of on nothing. Steers are skipped: one is already going out.
     *
     * Based on OpenCode v2's `onEmptySubmit`:
     * https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/routes/session/index.tsx
     */
    const steerFirstQueued = (): void => {
      const next = nextToSteer(ui.queue.pending);
      if (next === undefined) return;
      void steerQueued(next.entryId).catch(reportCommandError);
    };

    const editQueued = async (item: PendingItem): Promise<void> => {
      if (ui.input.plainText.trim() !== "") {
        notice(ui, "Send or clear the draft first, then edit the queued message");
        return;
      }
      if (!(await takeQueued(item.entryId))) return;
      setInputText(ui.input, composerParts.load(item.content));
      promptHistory.resetBrowse();
      focusComposer();
      notice(
        ui,
        `Back in the composer. Enter steers, ${keycap("chat.queue.submit")} queues.`,
        ui.transcript.theme.ok,
      );
    };

    const openQueue = async (): Promise<void> => {
      const items = ui.queue.pending;
      if (items.length === 0) {
        notice(ui, "Nothing is queued");
        return;
      }
      // One item still opens the list, because the row is no longer a single
      // possible answer: send it now, edit it, or drop it are three.
      const byId = new Map(items.map((item) => [item.entryId, item]));
      const edit = (entryId: string): void => {
        const item = byId.get(entryId);
        if (item !== undefined) void editQueued(item).catch(reportCommandError);
      };
      const actions: ChoiceAction[] = [
        { key: "e", ctrl: true, label: "edit", run: edit },
        {
          key: "d",
          ctrl: true,
          label: "delete",
          run: (entryId) => void deleteQueued(entryId).catch(reportCommandError),
        },
      ];
      try {
        const chosen = await selectChoice(
          ui,
          "Queued messages",
          items.map((item, index) => ({
            id: item.entryId,
            label: partsText(item.content).replaceAll("\n", " ").trim(),
            // The same word the gutter row shows, from the same table.
            description: `${String(index + 1)} \u00b7 ${DELIVERY[item.delivery].label}`,
          })),
          { actions, selectLabel: "send now" },
        );
        void steerQueued(chosen).catch(reportCommandError);
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
      // Drops out of the composer into the ephemeral slot, which borrows its
      // rows from the transcript's tail so no chat row moves.
      onRows(rows) {
        if (rows > 0) ui.ephemeral.mount(slashAutocomplete.container, rows);
        else ui.ephemeral.release(slashAutocomplete.container);
      },
    });
    ui.closeInlineMenus = () => slashAutocomplete.close();
    // Warm the catalog so the first model menu opens on a full list.
    void loadAuthenticatedModels(host.runtime.models).catch(() => undefined);

    if (flags.resume.kind !== "new" && initialBranch.length > 0) {
      const open = await host.sdk.runs.current({ sessionId: host.sessionId });
      replaceTranscript(ui, initialBranch, { openLastTurn: open !== undefined });
      if (open?.kind === "orphaned") turnNote(ui, "Resuming…", ui.transcript.theme.tool);
      else if (open?.kind === "live") {
        notice(ui, "Another uji is running this chat; following along.");
      }
      turnNote(ui, `Resumed · ${String(initialBranch.length)} entries`);
    }

    const refreshSlashAutocomplete = (): void => {
      // Mention discovery and other async callers can land after teardown,
      // and a destroyed composer has no edit buffer to read.
      if (ui.input.isDestroyed) return;
      refreshSlashAutocompleteAt(ui.input.plainText, ui.input.cursorOffset);
    };
    const refreshSlashAutocompleteAt = (value: string, cursor: number): void => {
      if (ui.inputMode !== "chat" || ui.selecting) {
        slashAutocomplete.close();
        return;
      }
      slashAutocomplete.update(value, slashCommandsForHost(host), mentionFiles, host.cwd, cursor);
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
      // microtask, with a render following), so this is the one place the
      // marker pills repaint; clear, load, restore, and submit all funnel
      // through here.
      composerMarkers.refresh(composerParts.current);
      refreshSlashAutocomplete();
      if (ui.inputMode === "chat" && ui.input.plainText !== "") {
        refreshHints(ui, host.state.busy);
      }
    };
    ui.input.onKeyDown = (key) => {
      if (!isComposerTextKey(key)) return;
      if (ui.input.hasSelection()) return;
      // OpenCode opens `/` from keydown instead of waiting for the textarea's
      // content callback. Project the typed character into the draft so `/re`
      // filters in the same input pass; the matching content callback is then a
      // no-op. Projecting at the cursor keeps that true mid-draft, where the
      // second skill of a prompt gets typed.
      const text = ui.input.plainText;
      const index = cellIndex(text, ui.input.cursorOffset);
      refreshSlashAutocompleteAt(
        `${text.slice(0, index)}${key.sequence}${text.slice(index)}`,
        ui.input.cursorOffset + displayWidth(key.sequence),
      );
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
          notice(ui, "paste failed: unsupported image data", ui.transcript.theme.error);
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
          notice(
            ui,
            `paste failed: ${error instanceof Error ? error.message : String(error)}`,
            ui.transcript.theme.error,
          );
        });
    };
    ui.input.onPaste = handleComposerPaste;

    ui.inputBox.onMouseDown = focusComposer;
    ui.input.onMouseUp = (event) => {
      if (event.button !== 0) return;
      // A drag that happens to end on a pill was someone selecting text.
      if ((renderer.getSelection()?.getSelectedText() ?? "") !== "") return;
      // The mousedown already parked the cursor at the clicked cell, so the
      // cursor offset is the click offset.
      if (composerMarkers.toggleAtOffset(ui.input.cursorOffset)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
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

    function toBottom() {
      setTimeout(() => {
        if (ui.scroll.isDestroyed) return;
        ui.scroll.stickyScroll = true;
        ui.scroll.scrollTo(ui.scroll.scrollHeight);
      }, 50);
    }

    let submitting = false;
    const submitComposer = (delivery: "steer" | "queue" = "steer"): void => {
      if (ui.inputMode !== "chat" || ui.selecting) return;
      if (slashAutocomplete.accepting) return;
      if (submitting) return;
      const draft = ui.input.plainText;
      const submission = parseComposerSubmission(draft);
      if (submission.kind === "empty") {
        // Only enter. Queueing an empty composer would have nothing to queue.
        if (delivery === "steer") steerFirstQueued();
        return;
      }
      const skills = host.skills;
      const commandTarget =
        submission.kind === "command"
          ? resolveSlashCommandTarget(host, submission.command.name)
          : undefined;
      // A skill named inside the draft makes the whole thing a prompt: the
      // message carries every invocation it mentions, not only a leading one.
      // A slash-prefixed line only becomes a command when the current host can
      // invoke it. Unknown names remain ordinary chat text.
      const prompting =
        submission.kind === "prompt" ||
        commandTarget?.kind === "message" ||
        hasInlineSkills(draft, skills);
      // Snapshots the draft's parts synchronously, so clearing the composer on
      // the next line cannot strip them before their bodies finish loading.
      const preparing = prompting
        ? composerParts.prepare(draft, undefined, (text) => expandInlineSkills(text, skills))
        : undefined;
      submitting = true;
      ui.input.clear();
      promptHistory.resetBrowse();
      slashAutocomplete.close();
      if (preparing === undefined) {
        if (submission.kind === "command" && commandTarget !== undefined) {
          void runCommand(ui, commandContext, submission.command, {
            delivery,
            target: commandTarget,
          }).catch(reportCommandError);
        }
      } else {
        toBottom();
        void (async () => {
          const prepared = await preparing;
          const text = prepared.displayText;
          promptHistory.record(text);
          try {
            // A plain line answers a parked question through the reply
            // channel. A run parked on some other tool, or no parked run at
            // all, takes ordinary open admission.
            const { content } = prepared.message;
            const answered =
              host.state.waiting &&
              delivery === "steer" &&
              typeof content === "string" &&
              (
                await host.sdk.runs.reply({
                  sessionId: host.sessionId,
                  toolName: "question",
                  reply: content,
                })
              ).ok;
            if (!answered) {
              await host.sdk.messages.send({ sessionId: host.sessionId, content, delivery });
            }
          } catch (error) {
            restoreRejectedInput(draft, prepared.parts);
            throw error;
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
      refreshHints(ui, host.state.busy);
    };

    let cyclingThinking = false;
    const cycleThinkingLevel = (): void => {
      if (cyclingThinking || host.state.busy) {
        return;
      }
      const next = nextThinkingLevel(host.thinkingLevel, getSupportedThinkingLevels(host.model));
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
      if (cyclingModel || host.state.busy) {
        return;
      }
      cyclingModel = true;
      void (async () => {
        const { models } = host.runtime;
        const available =
          cachedAuthenticatedModels(models) ?? (await loadAuthenticatedModels(models));
        if (available.length < 2) return;
        const current = available.findIndex(
          (model) => model.provider === host.runtime.provider.id && model.id === host.model.id,
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
          // A completion with rows in it answers these keys itself, from the
          // listener below; an empty one is a note and claims nothing. A drag
          // selection has its own layer above this one.
          !slashAutocomplete.accepting,
        commands: {
          "chat.interrupt": {
            title: "Stop the current run",
            run: () => {
              const intent = escapeIntent({
                selecting: ui.selecting,
                inputMode: ui.inputMode,
                authenticating: ui.authenticating,
                hasDraft: ui.input.plainText.trim() !== "",
                busy: host.state.busy || host.state.waiting,
              });
              if (intent === "ignore") return false;
              if (intent === "abort") {
                void host.sdk.runs.abort({ sessionId: host.sessionId, continue: true });
                return true;
              }
              // Double escape opens the tree, pi's default `doubleEscapeAction`.
              // https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2862
              if (doubleEscape.press()) void openTree({}).catch(reportCommandError);
              return true;
            },
          },
          "chat.scroll.page.up": {
            title: "Scroll the transcript up",
            run: () => ui.scroll.scrollBy(-0.5, "viewport"),
          },
          "chat.scroll.page.down": {
            title: "Scroll the transcript down",
            run: () => ui.scroll.scrollBy(0.5, "viewport"),
          },
          "chat.message.previous": {
            title: "Previous message",
            run: () => navigateTranscriptMessage(ui.scroll, "previous") !== undefined,
          },
          "chat.message.next": {
            title: "Next message",
            run: () => navigateTranscriptMessage(ui.scroll, "next") !== undefined,
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
            title: "Edit or remove queued messages",
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
          "chat.tools.toggle": {
            title: "Expand or collapse all tool output",
            run: () => {
              const expanded = ui.transcript.toolOutput.toggle();
              notice(ui, `Tool output ${expanded ? "expanded" : "collapsed"}`);
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
          // Plain up/down walk the draft's rows, wrapped ones included;
          // history only takes over from its start and end, as in a shell.
          "chat.history.previous": {
            title: "Previous message you sent",
            run: () => browseHistory(ui.input, promptHistory, "previous"),
          },
          "chat.history.next": {
            title: "Next message you sent",
            run: () => browseHistory(ui.input, promptHistory, "next"),
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
