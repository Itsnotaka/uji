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
import type { AgentMessage, HarnessEvent } from "@uji-ai/core";
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

function messageText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
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

function showStatus(ui: Ui, host: Host): void {
  ui.status.content = `${modelLabel(host.harness.state.model)}  ${HINT}`;
}

interface Picker {
  readonly isOpen: boolean;
  open: () => Promise<void>;
  close: () => void;
}

/** Ctrl+P overlay listing every model the stored credentials can reach. */
function createPicker(ui: Ui, host: Host, onPick: (model: Model<Api>) => void): Picker {
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
      const current = host.harness.state.model;
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

function replay(ui: Ui, host: Host): Promise<void> {
  return host.harness.session.getBranch("main").then((branch) => {
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const { message } = entry;
      if (message.role === "user") {
        const text = messageText(message);
        if (text !== "") addLine(ui, text, COLOR.user);
        continue;
      }
      if (message.role !== "assistant") continue;
      const text = messageText(message);
      if (text !== "") addLine(ui, text, COLOR.assistant);
      for (const part of message.content) {
        if (part.type === "toolCall") addLine(ui, part.name, COLOR.tool);
      }
    }
  });
}

function bindTranscript(ui: Ui, host: Host): () => void {
  let live: { node: TextRenderable; text: string } | undefined;
  return host.harness.subscribe((event: HarnessEvent) => {
    if (event.type === "message_start" && event.message.role === "user") {
      live = undefined;
      const text = messageText(event.message);
      if (text !== "") addLine(ui, text, COLOR.user);
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (live === undefined) live = { node: addLine(ui, "", COLOR.assistant), text: "" };
      live.text += event.assistantMessageEvent.delta;
      live.node.content = live.text;
      return;
    }
    if (event.type === "message_end") {
      live = undefined;
      return;
    }
    if (event.type === "tool_execution_start") {
      live = undefined;
      addLine(ui, event.toolName, COLOR.tool);
      return;
    }
    if (event.type === "turn_end" && event.message.role === "assistant") {
      const error = event.message.errorMessage;
      if (error !== undefined) addLine(ui, error, COLOR.error);
    }
  });
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

  const unsubscribe = bindTranscript(ui, host);
  await replay(ui, host);
  showStatus(ui, host);
  const picker = createPicker(ui, host, (model) => {
    host.harness.setModel(model);
    showStatus(ui, host);
    addLine(ui, `model → ${modelLabel(model)}`, COLOR.tool);
  });
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
    void host.harness
      .submit(text)
      .then((result) => {
        if (!result.ok) addLine(ui, result.error.message, COLOR.error);
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
      void host.harness.abort();
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
    unsubscribe();
    await host.close();
  }
}
