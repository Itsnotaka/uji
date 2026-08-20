import process from "node:process";
import { describeToolCall, displayDelta } from "./format.ts";
import type { RunFlags } from "./run.ts";
import { openHarness, resolveRuntime } from "./run.ts";

/** Non-interactive run: stream deltas and tool lines to stdout, then exit. */
export async function runPrint(flags: RunFlags): Promise<void> {
  const runtime = await resolveRuntime(flags);
  if (runtime === undefined) {
    throw new Error("Couldn't find a stored credential. Run `pnpm start login`.");
  }
  const { harness, suspended, sessionId, repo } = await openHarness(runtime, flags);
  let needsNewline = false;
  harness.subscribe((event) => {
    const delta = event.type === "message_update" ? displayDelta(event) : undefined;
    if (delta?.kind === "text") {
      process.stdout.write(delta.text);
      needsNewline = true;
    } else if (event.type === "tool_execution_start") {
      if (needsNewline) process.stdout.write("\n");
      needsNewline = false;
      const { title } = describeToolCall(event.toolName, event.args);
      console.log(event.toolName === "bash" ? title : `[${title}]`);
    }
  });
  process.once("SIGINT", () => void harness.abort());

  if (suspended.length > 0) {
    console.error(`resuming suspended run ${suspended[0]?.id ?? ""}…`);
    await harness.resume();
  }
  const result = await harness.prompt(flags.rest.join(" "));
  await repo.close();
  if (needsNewline) process.stdout.write("\n");
  if (!result.ok) {
    console.error(`error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.value.kind === "failed") {
    console.error(`error: ${result.value.error.message}`);
    process.exitCode = 1;
  }
  console.error(
    `session: ${sessionId} (${runtime.provider.id}, ${runtime.auth.source ?? "auth"}, ${result.value.kind})`,
  );
}
