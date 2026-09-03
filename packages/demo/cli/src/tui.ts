import process from "node:process";
import {
  BoxRenderable,
  createCliRenderer,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import type {
  CliRenderer,
  KeyEvent,
  SelectOption,
  TextareaRenderable as Input,
} from "@opentui/core";
import type { Api, Model } from "@uji-ai/ai";
import type { Turn } from "@uji-ai/core";
import type { Host } from "./host.ts";

/**
 * GrokNight — neutral gray base, TokyoNight accents.
 * From https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs
 */
const COLOR = {
  terminal: "#0a0a0a",
  background: "#141414",
  foreground: "#e1e1e1",
  user: "#c8c8c8",
  assistant: "#bb9af7",
  tool: "#787878",
  error: "#f7768e",
  promptBorder: "#323237",
  promptBorderFocused: "#505058",
} as const;

const HINT = "ctrl+p model · esc stop · ctrl+c quit";

interface Ui {
  renderer: CliRenderer;
  root: BoxRenderable;
  scroll: ScrollBoxRenderable;
  inputBox: BoxRenderable;
  input: Input;
  status: TextRenderable;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text !== "")
    .join("");
}

function addLine(ui: Ui, text: string, color: string): TextRenderable {
  const node = new TextRenderable(ui.renderer, {
    content: text,
    fg: color,
    wrapMode: "word",
    width: "auto",
    marginTop: 1,
  });
  ui.scroll.add(node);
  return node;
}

function buildUi(renderer: CliRenderer): Ui {
  const root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLOR.background,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    minHeight: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollX: false,
    scrollY: true,
    paddingLeft: 1,
    paddingRight: 1,
    paddingBottom: 1,
  });
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    flexDirection: "row",
    height: 3,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.promptBorder,
    focusedBorderColor: COLOR.promptBorderFocused,
    focusable: true,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = new TextRenderable(renderer, {
    id: "input-prompt",
    content: "❯ ",
    fg: COLOR.user,
    height: 1,
  });
  const input = new TextareaRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    height: 1,
    wrapMode: "word",
    placeholder: "",
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: COLOR.foreground,
    focusedTextColor: COLOR.foreground,
    cursorColor: COLOR.user,
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
    ],
  });
  const status = new TextRenderable(renderer, {
    id: "status",
    content: "",
    fg: COLOR.tool,
    height: 1,
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
  });
  inputBox.add(prompt);
  inputBox.add(input);
  root.add(scroll);
  root.add(inputBox);
  root.add(status);
  renderer.root.add(root);
  input.focus();
  return { renderer, root, scroll, inputBox, input, status };
}

function modelLabel(model: Model<Api>): string {
  return `${model.name} · ${model.provider}`;
}

interface Picker {
  readonly isOpen: boolean;
  open: () => Promise<void>;
  close: () => void;
}

/** Ctrl+P overlay listing every model the stored credentials can reach. */
function createPicker(
  ui: Ui,
  host: Host,
  currentModel: () => Model<Api>,
  onPick: (model: Model<Api>) => void,
): Picker {
  const box = new BoxRenderable(ui.renderer, {
    id: "model-picker",
    flexDirection: "column",
    flexShrink: 0,
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.promptBorder,
    title: "model",
    titleColor: COLOR.tool,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const select = new SelectRenderable(ui.renderer, {
    id: "model-select",
    flexGrow: 1,
    options: [],
    showDescription: false,
    wrapSelection: true,
    showScrollIndicator: true,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: COLOR.foreground,
    focusedTextColor: COLOR.foreground,
    selectedBackgroundColor: "transparent",
    selectedTextColor: COLOR.assistant,
  });
  box.add(select);

  let models: readonly Model<Api>[] = [];
  let isOpen = false;

  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    ui.root.remove(box);
    ui.input.focus();
  };

  select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const model = models[index];
    close();
    if (model !== undefined) onPick(model);
  });

  return {
    get isOpen() {
      return isOpen;
    },
    open: async () => {
      if (isOpen) return;
      if (models.length === 0) models = await host.listModels().catch(() => []);
      if (models.length === 0) return;
      const current = currentModel();
      const options: SelectOption[] = models.map((model) => ({
        name:
          model.id === current.id && model.provider === current.provider
            ? `${modelLabel(model)}  (current)`
            : modelLabel(model),
        description: "",
      }));
      select.options = options;
      const index = models.findIndex(
        (model) => model.id === current.id && model.provider === current.provider,
      );
      select.setSelectedIndex(index === -1 ? 0 : index);
      box.height = Math.min(models.length, 8) + 2;
      ui.root.insertBefore(box, ui.inputBox);
      isOpen = true;
      select.focus();
    },
    close,
  };
}

/**
 * Render one projected turn: the user line, assistant text, and one line per
 * tool call. A tool part that carries its result already announced itself on
 * the assistant entry, so it draws nothing here.
 */
function renderTurn(ui: Ui, turn: Turn, live?: { node: TextRenderable; entryId: string }): void {
  if (turn.kind !== "turn") return;
  let assistantText = "";
  let assistantEntryId: string | undefined;
  for (const part of turn.parts) {
    if (part.kind === "user") {
      const text = userText(part.content);
      if (text !== "") addLine(ui, text, COLOR.user);
    } else if (part.kind === "assistant") {
      assistantText += part.text;
      assistantEntryId = part.entryId;
    } else if (part.kind === "tool" && part.result === undefined) {
      addLine(ui, part.toolName, COLOR.tool);
    }
  }
  if (assistantText === "") return;
  if (live !== undefined && live.entryId === assistantEntryId) {
    live.node.content = assistantText;
    return;
  }
  addLine(ui, assistantText, COLOR.assistant);
}

export async function runTui(command: { resume: boolean }): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: COLOR.terminal,
    clearOnShutdown: true,
  });
  const destroyed = new Promise<void>((resolve) => {
    renderer.on("destroy", () => resolve());
  });
  const ui = buildUi(renderer);

  const { openHost } = await import("./host.ts");
  const host = await openHost({ resume: command.resume }).catch(async (error: unknown) => {
    renderer.destroy();
    await destroyed;
    throw error;
  });
  const { sdk, sessionId } = host;

  // The declared model wins over the composition fallback, here as in the run.
  let current = host.model;
  const declared = (await sdk.sessions.get({ sessionId }))?.config.model;
  if (declared?.provider !== undefined) {
    current = host.runtime.models.getModel(declared.provider, declared.id) ?? current;
  }
  const showStatus = (): void => {
    ui.status.content = `${modelLabel(current)}  ${HINT}`;
  };

  for (const turn of await sdk.messages.list({ sessionId })) renderTurn(ui, turn);
  showStatus();

  // Live rendering: deltas stream into one node per assistant entry, and the
  // committed turn replaces the accumulation with the settled text.
  let live: { node: TextRenderable; entryId: string; text: string } | undefined;
  const watchController = new AbortController();
  const watcher = (async (): Promise<void> => {
    for await (const event of sdk.watch({
      sessionId,
      live: true,
      signal: watchController.signal,
    })) {
      if (event.kind === "text_delta") {
        if (live?.entryId !== event.entryId) {
          live = { node: addLine(ui, "", COLOR.assistant), entryId: event.entryId, text: "" };
        }
        live.text += event.delta;
        live.node.content = live.text;
        continue;
      }
      if (event.kind === "message") {
        renderTurn(ui, event.turn, live);
        if (live !== undefined && event.entryId === live.entryId) live = undefined;
        continue;
      }
      if (event.kind === "run_finished" && event.outcome.kind === "failed") {
        addLine(ui, event.outcome.error.message, COLOR.error);
      }
    }
  })();

  const picker = createPicker(
    ui,
    host,
    () => current,
    (model) => {
      void sdk.sessions
        .configure({ sessionId, model: { provider: model.provider, id: model.id } })
        .then((outcome) => {
          if (outcome.kind === "unknown_model") {
            addLine(ui, `unknown model: ${model.id}`, COLOR.error);
            return;
          }
          current = model;
          showStatus();
          addLine(
            ui,
            outcome.kind === "deferred"
              ? `model → ${modelLabel(model)} (after this run)`
              : `model → ${modelLabel(model)}`,
            COLOR.tool,
          );
        });
    },
  );
  let submitting = false;
  ui.input.onSubmit = () => {
    const text = ui.input.plainText.trim();
    if (text === "" || submitting) return;
    if (text === "/model") {
      ui.input.clear();
      void picker.open();
      return;
    }
    submitting = true;
    ui.input.clear();
    void sdk.messages
      .send({ sessionId, content: text })
      .catch((error: unknown) => {
        addLine(ui, error instanceof Error ? error.message : String(error), COLOR.error);
      })
      .finally(() => {
        submitting = false;
      });
  };
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "p") {
      key.preventDefault();
      if (picker.isOpen) picker.close();
      else void picker.open();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (picker.isOpen) {
        picker.close();
        return;
      }
      void sdk.runs.abort({ sessionId });
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      picker.close();
      renderer.destroy();
    }
  });

  const onSignal = () => {
    renderer.destroy();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await destroyed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    watchController.abort();
    await watcher.catch(() => undefined);
    await host.close();
  }
}
