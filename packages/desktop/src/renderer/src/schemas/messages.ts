/**
 * `@uji-ai/schema`'s neutral message model, as Zod. These are the leaves the
 * transcript and pending schemas compose; each is checked against the
 * interface it claims so the two cannot drift apart silently.
 */
import type {
  AssistantMessage,
  ImageContent,
  JsonValue,
  Message,
  ProviderCheckpointMaterial,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@uji-ai/schema";
import { z } from "./zod.ts";

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const textContent = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
}) satisfies z.ZodType<TextContent>;

export const thinkingContent = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
}) satisfies z.ZodType<ThinkingContent>;

export const imageContent = z.strictObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
}) satisfies z.ZodType<ImageContent>;

export const toolCall = z.strictObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
  namespace: z.string().optional(),
}) satisfies z.ZodType<ToolCall>;

export const usage = z.strictObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.strictObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
}) satisfies z.ZodType<Usage>;

/** What a user turn or pending item carries. */
export const userContent = z.union([
  z.string(),
  z.array(z.discriminatedUnion("type", [textContent, imageContent])),
]) satisfies z.ZodType<UserMessage["content"]>;

export const userMessage = z.strictObject({
  role: z.literal("user"),
  content: userContent,
  timestamp: z.number(),
}) satisfies z.ZodType<UserMessage>;

const diagnosticErrorInfo = z.strictObject({
  name: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});

const assistantMessageDiagnostic = z.strictObject({
  type: z.string(),
  timestamp: z.number(),
  error: diagnosticErrorInfo.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const deferredHandle = z.strictObject({
  provider: z.string(),
  modelId: z.string(),
  api: z.string(),
  id: z.string(),
  expiresAt: z.number().optional(),
  pollAfterMs: z.number().optional(),
  data: jsonValue.optional(),
});

export const stopReason = z.enum([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

export const assistantMessage = z.strictObject({
  role: z.literal("assistant"),
  content: z.array(z.discriminatedUnion("type", [textContent, thinkingContent, toolCall])),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  diagnostics: z.array(assistantMessageDiagnostic).optional(),
  usage,
  stopReason,
  deferred: deferredHandle.optional(),
  errorMessage: z.string().optional(),
  rawStopReason: z.string().optional(),
  endTurn: z.boolean().optional(),
  timestamp: z.number(),
}) satisfies z.ZodType<AssistantMessage>;

export const toolResultMessage = z.strictObject({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.discriminatedUnion("type", [textContent, imageContent])),
  // Tool-defined and typed by each tool upstream; the renderer reads it by shape.
  details: z.unknown().optional(),
  title: z.string().optional(),
  usage: usage.optional(),
  addedToolNames: z.array(z.string()).optional(),
  isError: z.boolean(),
  timestamp: z.number(),
}) satisfies z.ZodType<ToolResultMessage>;

export const message = z.discriminatedUnion("role", [
  userMessage,
  assistantMessage,
  toolResultMessage,
]) satisfies z.ZodType<Message>;

export const providerCheckpointMaterial = z.strictObject({
  type: z.literal("provider"),
  provider: z.string(),
  api: z.string(),
  model: z.string(),
  data: jsonValue,
}) satisfies z.ZodType<ProviderCheckpointMaterial>;
