import process from "node:process";
import { WorkspaceTrustRequired } from "@uji-ai/core";
import { describeToolCall, shortId } from "./format.ts";
import type { RunFlags } from "./flags.ts";
import { openHarness, resolveRuntime } from "./run.ts";
import { FileSettingsStore } from "./settings.ts";
import { createWorkspaceTrustStore } from "./workspace-trust.ts";

export type PrintJsonEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; title: string }
  | { type: "result"; session: string; provider: string; kind: string }
  | { type: "error"; message: string };

export function encodePrintJson(event: PrintJsonEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function writeJson(event: PrintJsonEvent): void {
  process.stdout.write(encodePrintJson(event));
}

function writeHumanError(message: string, json: boolean): void {
  if (json) writeJson({ type: "error", message });
  else console.error(`error: ${message}`);
}

/** Non-interactive run: stream deltas and tool lines, then exit. */
export async function runPrint(flags: RunFlags): Promise<void> {
  const trustStore = createWorkspaceTrustStore();
  const workspace = await trustStore.require(process.cwd()).catch((error: unknown) => {
    if (error instanceof WorkspaceTrustRequired) {
      throw new Error(
        `Workspace is not trusted: ${error.cwd}. Run \`uji\` interactively to trust it first.`,
      );
    }
    throw error;
  });
  const settingsStore = new FileSettingsStore();
  const settings = await settingsStore.read(workspace.cwd);
  const runtime = await resolveRuntime(flags, settings);
  if (runtime === undefined) {
    throw new Error("Couldn't find a stored credential. Run `uji login`.");
  }
  const { harness, suspended, sessionId, repo } = await openHarness(runtime, flags, {
    settings,
    workspace,
  });
  let needsNewline = false;
  const unsubscribe = harness.subscribe(async (event) => {
    if (event.type === "agent_start") {
      await settingsStore.updateGlobal({
        defaultProvider: runtime.provider.id,
        defaultModel: harness.state.model.id,
        defaultThinkingLevel: harness.state.thinkingLevel ?? "off",
      });
    }
    const assistantEvent =
      event.type === "message_update" ? event.assistantMessageEvent : undefined;
    const text = assistantEvent?.type === "text_delta" ? assistantEvent.delta : undefined;
    if (text !== undefined) {
      if (flags.json) writeJson({ type: "text", text });
      else {
        process.stdout.write(text);
        needsNewline = true;
      }
    } else if (event.type === "tool_execution_start" && !flags.quiet) {
      const title = describeToolCall(event.toolName, event.args).title;
      if (flags.json) {
        writeJson({ type: "tool", name: event.toolName, title });
        return;
      }
      if (needsNewline) process.stdout.write("\n");
      needsNewline = false;
      console.log(title);
    }
  });
  let signalExitCode: number | undefined;
  const onSigint = () => {
    signalExitCode = 130;
    void harness.close().catch(() => undefined);
  };
  const onSigterm = () => {
    signalExitCode = 143;
    void harness.close().catch(() => undefined);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const result = await (async () => {
    try {
      if (suspended.length > 0) {
        if (!flags.json) console.error(`resuming suspended operation ${suspended[0]?.id ?? ""}…`);
        await harness.resume();
      }
      return await harness.prompt(flags.rest.join(" "));
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      unsubscribe();
      await harness.close().catch(() => undefined);
      await repo.close();
    }
  })();
  if (needsNewline) process.stdout.write("\n");
  if (signalExitCode !== undefined) {
    process.exitCode = signalExitCode;
    return;
  }
  if (!result.ok) {
    writeHumanError(result.error.message, flags.json);
    process.exitCode = 1;
    return;
  }
  if (result.value.kind === "failed") {
    writeHumanError(result.value.error.message, flags.json);
    process.exitCode = 1;
    return;
  }
  if (flags.json) {
    writeJson({
      type: "result",
      session: sessionId,
      provider: runtime.provider.id,
      kind: result.value.kind,
    });
    return;
  }
  console.error(`session ${shortId(sessionId)} · ${runtime.provider.id} · ${result.value.kind}`);
  console.error("resume with: uji -p --resume");
}
