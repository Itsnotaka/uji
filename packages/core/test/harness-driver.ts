/**
 * Test-side stand-ins for the verbs a harness no longer has. Admission goes
 * through the store, an attached harness picks the work up, and a test waits
 * on the durable record: the same path every host takes. `open` helpers must
 * call `harness.attach()` for these to make progress.
 */
import type { Message } from "@uji-ai/schema";
import type { AgentHarness } from "../src/harness/agent-harness.ts";
import { finishedFromRecord, type RunnerFinished } from "../src/harness/runner.ts";
import type { SessionStorage } from "../src/harness/session/types.ts";
import { pendingItemsFromLog } from "../src/sdk/snapshot.ts";
import type { PendingItem } from "../src/sdk/types.ts";

const HEAD = "main";

export type Submitted =
  /** Placed on an idle head; `runId` is the run an attached harness started for it. */
  | { disposition: "started"; entryId: string; runId: string }
  /** Queued behind the live run `runId`, which drains it. */
  | { disposition: "queued"; entryId: string; runId: string };

export async function submit(
  harness: AgentHarness,
  input: string | Message,
  delivery: "steer" | "queue" = "steer",
): Promise<Submitted> {
  const { session } = harness;
  const message: Message =
    typeof input === "string" ? { role: "user", content: input, timestamp: Date.now() } : input;
  const before = await session.lastSeq();
  const receipt = await session.send(message, { delivery });
  if (receipt.disposition === "queued") {
    return { disposition: "queued", entryId: receipt.entryId, runId: receipt.runId };
  }
  for await (const item of session.watch({ afterSeq: before })) {
    if (
      item.kind === "record" &&
      item.record.type === "operation_started" &&
      item.record.head === HEAD
    ) {
      return { disposition: "started", entryId: receipt.entryId, runId: item.record.id };
    }
  }
  throw new Error(`Session closed before a run picked up ${receipt.entryId}`);
}

/** Submit, then await the terminal record of the run that takes the message. */
export async function prompt(harness: AgentHarness, input: string | Message): Promise<RunnerFinished> {
  const sent = await submit(harness, input);
  return waitFinished(harness.session, sent.runId);
}

export async function waitFinished(session: SessionStorage, runId: string): Promise<RunnerFinished> {
  const after = await session.lastSeq();
  const initial = await session.runState(runId);
  if (initial.kind === "finished") {
    return finishedFromRecord(initial, await session.getLeafId(HEAD));
  }
  for await (const item of session.watch({ afterSeq: after })) {
    if (
      item.kind !== "record" ||
      item.record.type !== "operation_finished" ||
      item.record.runId !== runId
    ) {
      continue;
    }
    const state = await session.runState(runId);
    if (state.kind === "finished") return finishedFromRecord(state, await session.getLeafId(HEAD));
  }
  throw new Error(`Session closed before ${runId} finished`);
}

/** Resolves once the head holds no open operation and no live claim. */
export async function waitForIdle(harness: AgentHarness): Promise<void> {
  const { session } = harness;
  for (;;) {
    const open = (await session.findOpenOperations(HEAD))[0];
    if (open !== undefined) {
      await waitFinished(session, open.id);
      continue;
    }
    if ((await session.getLiveClaim(HEAD)) === undefined) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function pendingQueue(harness: AgentHarness): Promise<readonly PendingItem[]> {
  return pendingItemsFromLog(await harness.session.getLog());
}
