// Main is the only Electron process allowed to JIT validators. This import must
// run before the schemas below are constructed; the renderer's CSP forbids eval.
import "zod/compile";
import { z } from "zod";
import type { Uji } from "@uji-ai/core";
import { asSessionId } from "../shared/ipc.ts";
import type {
  CallInput,
  CallOutput,
  CallPath,
  CallRequest,
  SdkVerbPath,
  WatchStartInput,
} from "../shared/ipc.ts";

const sessionId = z.string().min(1, "Invalid session id").transform(asSessionId);
const id = z.string();
const seq = z.number().int();
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const noInput = z.undefined();

const textContent = z.strictObject({ type: z.literal("text"), text: z.string() });
const imageContent = z.strictObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const userContent = z.union([z.string(), z.array(z.union([textContent, imageContent]))]);
const sessionHead = z.strictObject({ sessionId, head: id.optional() });

export const CALL_INPUT_SCHEMAS = {
  "sessions.create": z
    .strictObject({ sessionId: sessionId.optional(), name: z.string().optional() })
    .optional(),
  "sessions.get": z.strictObject({ sessionId }),
  "sessions.snapshot": sessionHead,
  "sessions.list": z
    .strictObject({
      search: z.string().optional(),
      limit: z.number().finite().optional(),
      cursor: z.string().optional(),
    })
    .optional(),
  "sessions.rename": z.strictObject({ sessionId, name: z.string() }),
  "sessions.delete": z.strictObject({ sessionId }),
  "sessions.configure": z.strictObject({
    sessionId,
    model: z.strictObject({ provider: z.string(), id }).optional(),
    thinkingLevel: thinkingLevel.optional(),
  }),
  "messages.send": z.strictObject({
    sessionId,
    entryId: id.optional(),
    content: userContent,
    delivery: z.enum(["steer", "queue"]).optional(),
    head: id.optional(),
  }),
  "messages.cancel": z.strictObject({ sessionId, entryId: id }),
  "messages.redeliver": z.strictObject({
    sessionId,
    entryId: id,
    delivery: z.enum(["steer", "queue"]),
  }),
  "runs.abort": z.strictObject({
    sessionId,
    runId: id.optional(),
    continue: z.boolean().optional(),
  }),
  "runs.changes": z.strictObject({
    sessionId,
    head: id.optional(),
    runId: id.optional(),
  }),
  "workspace.list": noInput,
  "workspace.forget": z.strictObject({ path: z.string() }),
  "workspace.vcs.diff": z.strictObject({ paths: z.array(z.string()).optional() }).optional(),
  "provider.models.default": noInput,
  "plugins.list": z.strictObject({ sessionId }),
  "plugins.settings.list": z.strictObject({ sessionId }),
  "plugins.settings.apply": z.strictObject({
    sessionId,
    id,
    choiceId: id,
  }),
  "plugins.resources.list": z.strictObject({ sessionId }),
  "host.state": noInput,
  "host.openWorkspace": z.strictObject({ path: z.string() }),
  "host.pickWorkspace": noInput,
  "host.trustWorkspace": z.strictObject({ path: z.string() }),
  "host.closeWorkspace": noInput,
  "host.providers": noInput,
  "host.login": z.strictObject({ provider: z.string() }),
  "host.logout": z.strictObject({ provider: z.string() }),
  "host.models": noInput,
  "host.vcs.snapshot": noInput,
  "host.github.state": noInput,
  "host.github.refresh": noInput,
  "host.github.signIn": noInput,
  "host.github.signOut": noInput,
  "host.openExternal": z.strictObject({ url: z.string() }),
} satisfies { readonly [P in CallPath]: z.ZodType<CallInput<P>> };

function callRequestFor<P extends CallPath>(path: P, input: z.ZodType<CallInput<P>>) {
  return z.strictObject({ path: z.literal(path), input });
}

const callRequest = z.discriminatedUnion("path", [
  callRequestFor("sessions.create", CALL_INPUT_SCHEMAS["sessions.create"]),
  callRequestFor("sessions.get", CALL_INPUT_SCHEMAS["sessions.get"]),
  callRequestFor("sessions.snapshot", CALL_INPUT_SCHEMAS["sessions.snapshot"]),
  callRequestFor("sessions.list", CALL_INPUT_SCHEMAS["sessions.list"]),
  callRequestFor("sessions.rename", CALL_INPUT_SCHEMAS["sessions.rename"]),
  callRequestFor("sessions.delete", CALL_INPUT_SCHEMAS["sessions.delete"]),
  callRequestFor("sessions.configure", CALL_INPUT_SCHEMAS["sessions.configure"]),
  callRequestFor("messages.send", CALL_INPUT_SCHEMAS["messages.send"]),
  callRequestFor("messages.cancel", CALL_INPUT_SCHEMAS["messages.cancel"]),
  callRequestFor("messages.redeliver", CALL_INPUT_SCHEMAS["messages.redeliver"]),
  callRequestFor("runs.abort", CALL_INPUT_SCHEMAS["runs.abort"]),
  callRequestFor("runs.changes", CALL_INPUT_SCHEMAS["runs.changes"]),
  callRequestFor("workspace.list", CALL_INPUT_SCHEMAS["workspace.list"]),
  callRequestFor("workspace.forget", CALL_INPUT_SCHEMAS["workspace.forget"]),
  callRequestFor("workspace.vcs.diff", CALL_INPUT_SCHEMAS["workspace.vcs.diff"]),
  callRequestFor("provider.models.default", CALL_INPUT_SCHEMAS["provider.models.default"]),
  callRequestFor("plugins.list", CALL_INPUT_SCHEMAS["plugins.list"]),
  callRequestFor("plugins.settings.list", CALL_INPUT_SCHEMAS["plugins.settings.list"]),
  callRequestFor("plugins.settings.apply", CALL_INPUT_SCHEMAS["plugins.settings.apply"]),
  callRequestFor("plugins.resources.list", CALL_INPUT_SCHEMAS["plugins.resources.list"]),
  callRequestFor("host.state", CALL_INPUT_SCHEMAS["host.state"]),
  callRequestFor("host.openWorkspace", CALL_INPUT_SCHEMAS["host.openWorkspace"]),
  callRequestFor("host.pickWorkspace", CALL_INPUT_SCHEMAS["host.pickWorkspace"]),
  callRequestFor("host.trustWorkspace", CALL_INPUT_SCHEMAS["host.trustWorkspace"]),
  callRequestFor("host.closeWorkspace", CALL_INPUT_SCHEMAS["host.closeWorkspace"]),
  callRequestFor("host.providers", CALL_INPUT_SCHEMAS["host.providers"]),
  callRequestFor("host.login", CALL_INPUT_SCHEMAS["host.login"]),
  callRequestFor("host.logout", CALL_INPUT_SCHEMAS["host.logout"]),
  callRequestFor("host.models", CALL_INPUT_SCHEMAS["host.models"]),
  callRequestFor("host.vcs.snapshot", CALL_INPUT_SCHEMAS["host.vcs.snapshot"]),
  callRequestFor("host.github.state", CALL_INPUT_SCHEMAS["host.github.state"]),
  callRequestFor("host.github.refresh", CALL_INPUT_SCHEMAS["host.github.refresh"]),
  callRequestFor("host.github.signIn", CALL_INPUT_SCHEMAS["host.github.signIn"]),
  callRequestFor("host.github.signOut", CALL_INPUT_SCHEMAS["host.github.signOut"]),
  callRequestFor("host.openExternal", CALL_INPUT_SCHEMAS["host.openExternal"]),
]) satisfies z.ZodType<CallRequest>;
const watchStart = z.union([
  z.strictObject({ watchId: z.string().min(1), sessionId, live: z.literal(true) }),
  z.strictObject({ watchId: z.string().min(1), sessionId, afterSeq: seq.optional() }),
]);
const watchStop = z.strictObject({ watchId: z.string().min(1) });

export function decodeCallRequest(input: CallRequest): CallRequest {
  return callRequest.parse(input);
}

export function decodeWatchStart(input: WatchStartInput): WatchStartInput {
  return watchStart.parse(input);
}

export function decodeWatchStop(input: { readonly watchId: string }): string {
  return watchStop.parse(input).watchId;
}

export interface SdkVerb {
  invoke(input: CallInput<SdkVerbPath>, getSdk: () => Uji): Promise<CallOutput<SdkVerbPath>>;
}

/** Bind an SDK verb to its exact input parser before it enters the dispatcher. */
export function sdkVerb<
  TInput extends CallInput<SdkVerbPath>,
  TResult extends CallOutput<SdkVerbPath>,
>(schema: z.ZodType<TInput>, run: (sdk: Uji, input: TInput) => Promise<TResult>): SdkVerb {
  return {
    invoke: (input, getSdk) => {
      const decoded = schema.parse(input);
      return run(getSdk(), decoded);
    },
  };
}
