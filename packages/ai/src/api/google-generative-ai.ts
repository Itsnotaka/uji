/**
 * Google Generative AI adapter.
 *
 * Based on:
 * - https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/api/google-generative-ai.ts
 * - https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/api/google-shared.ts
 * Synced with pi 77f2d1235.
 */
import {
  type Content,
  FinishReason,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  type Part,
  type ThinkingConfig,
  ThinkingLevel as GoogleThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  ModelThinkingLevel,
  ProviderHeaders,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingLevel,
  ThinkingBudgets,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getUjiUserAgent } from "../utils/uji-user-agent.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
  getJsonSchemaToolParameters,
  resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

type ResolvedThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

export interface GoogleOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number; // -1 for dynamic, 0 to disable
    level?: GoogleThinkingLevel;
  };
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "google-generative-ai",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      if (options?.fetch && options.fetch !== globalThis.fetch) {
        throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
      }
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      const client = createClient(model, apiKey, options?.headers);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as GenerateContentParameters;
      }
      const googleStream = await retryGoogleRequest(
        () => client.models.generateContentStream(params),
        options,
      );

      stream.push({ type: "start", partial: output });
      let currentBlock: TextContent | ThinkingContent | null = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      for await (const chunk of googleStream) {
        // @google/genai documents GenerateContentResponse.responseId as an output-only field
        // used to identify each response. Keep the first non-empty one from the stream.
        output.responseId ||= chunk.responseId;
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              const isThinking = isThinkingPart(part);
              if (
                !currentBlock ||
                (isThinking && currentBlock.type !== "thinking") ||
                (!isThinking && currentBlock.type !== "text")
              ) {
                if (currentBlock) {
                  if (currentBlock.type === "text") {
                    stream.push({
                      type: "text_end",
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output,
                    });
                  } else {
                    stream.push({
                      type: "thinking_end",
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output,
                    });
                  }
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                  output.content.push(currentBlock);
                  stream.push({
                    type: "thinking_start",
                    contentIndex: blockIndex(),
                    partial: output,
                  });
                } else {
                  currentBlock = { type: "text", text: "" };
                  output.content.push(currentBlock);
                  stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            }

            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === "text") {
                  stream.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output,
                  });
                } else {
                  stream.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output,
                  });
                }
                currentBlock = null;
              }

              // Generate unique ID if not provided or if it's a duplicate
              const providedId = part.functionCall.id;
              const needsNewId =
                !providedId ||
                output.content.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId
                ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                : providedId;

              const toolCall: ToolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              };

              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex: blockIndex(),
                toolCall,
                partial: output,
              });
            }
          }
        }

        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
            output.stopReason = "toolUse";
          }
        }

        if (chunk.usageMetadata) {
          output.usage = {
            input:
              (chunk.usageMetadata.promptTokenCount || 0) -
              (chunk.usageMetadata.cachedContentTokenCount || 0),
            output:
              (chunk.usageMetadata.candidatesTokenCount || 0) +
              (chunk.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          };
          calculateCost(model, output.usage);
        }
      }

      if (currentBlock) {
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        } else {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output,
          });
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "pending") {
        throw new Error("Google stream ended without a finish reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        const errorMessage = output.rawStopReason
          ? `Provider stopped with: ${output.rawStopReason}`
          : "An unknown error occurred";
        throw new Error(errorMessage);
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      // Remove internal index property used during streaming
      for (const block of output.content) {
        if ("index" in block) {
          delete (block as { index?: number }).index;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(normalizeProviderError(error));
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = {
    ...buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice,
  } satisfies GoogleOptions;
  if (!options?.reasoning) {
    return stream(model, context, {
      ...base,
      thinking: { enabled: false },
    } satisfies GoogleOptions);
  }

  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

  if (isGemini3ProModel(model) || isGemini3FlashModel(model) || isGemma4Model(model)) {
    return stream(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getThinkingLevel(resolvedLevel, model),
      },
    } satisfies GoogleOptions);
  }

  return stream(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
    },
  } satisfies GoogleOptions);
};

function createClient(
  model: Model<"google-generative-ai">,
  apiKey: string,
  optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
  const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } =
    {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
  }
  const headers = providerHeadersToRecord({
    "User-Agent": getUjiUserAgent(),
    ...model.headers,
    ...optionsHeaders,
  });
  if (headers) {
    httpOptions.headers = headers;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}

function buildParams(
  model: Model<"google-generative-ai">,
  context: Context,
  options: GoogleOptions = {},
): GenerateContentParameters {
  const contents = convertMessages(model, context);

  const generationConfig: GenerateContentConfig = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }

  const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
  const functionCallingMode = context.tools?.length
    ? resolveGoogleFunctionCallingMode(context.tools, options.toolChoice, supportsStrictMode)
    : undefined;
  const config: GenerateContentConfig = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
    ...(context.tools &&
      context.tools.length > 0 && {
        tools: convertTools(context.tools, supportsStrictMode),
      }),
    ...(functionCallingMode !== undefined && {
      toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
    }),
  };

  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== undefined) {
      thinkingConfig.thinkingLevel = options.thinking.level;
    } else if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    config.thinkingConfig = getDisabledThinkingConfig(model);
  }

  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }

  const params: GenerateContentParameters = {
    model: model.id,
    contents,
    config,
  };

  return params;
}

function isGemma4Model(model: Model<"google-generative-ai">): boolean {
  return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
  const id = model.id.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-flash/.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest"
  );
}

function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
  // Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
  // do not support full thinking-off either. For Gemini 3 models, use the lowest supported
  // thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
  if (isGemini3ProModel(model)) {
    return { thinkingLevel: GoogleThinkingLevel.LOW };
  }
  if (isGemini3FlashModel(model)) {
    return { thinkingLevel: GoogleThinkingLevel.MINIMAL };
  }
  if (isGemma4Model(model)) {
    return { thinkingLevel: GoogleThinkingLevel.MINIMAL };
  }

  // Gemini 2.x supports disabling via thinkingBudget = 0.
  return { thinkingBudget: 0 };
}

function getThinkingLevel(
  effort: ResolvedThinkingLevel,
  model: Model<"google-generative-ai">,
): GoogleThinkingLevel {
  if (isGemini3ProModel(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return GoogleThinkingLevel.LOW;
      case "medium":
      case "high":
        return GoogleThinkingLevel.HIGH;
    }
  }
  if (isGemma4Model(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return GoogleThinkingLevel.MINIMAL;
      case "medium":
      case "high":
        return GoogleThinkingLevel.HIGH;
    }
  }
  switch (effort) {
    case "minimal":
      return GoogleThinkingLevel.MINIMAL;
    case "low":
      return GoogleThinkingLevel.LOW;
    case "medium":
      return GoogleThinkingLevel.MEDIUM;
    case "high":
      return GoogleThinkingLevel.HIGH;
  }
}

function getGoogleBudget(
  model: Model<"google-generative-ai">,
  level: ResolvedThinkingLevel,
  customBudgets?: ThinkingBudgets,
): number {
  if (customBudgets?.[level] !== undefined) {
    return customBudgets[level]!;
  }

  if (model.id.includes("2.5-pro")) {
    const budgets: Record<ResolvedThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768,
    };
    return budgets[level];
  }

  if (model.id.includes("2.5-flash-lite")) {
    const budgets: Record<ResolvedThinkingLevel, number> = {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[level];
  }

  if (model.id.includes("2.5-flash")) {
    const budgets: Record<ResolvedThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[level];
  }

  return -1;
}

function resolveGoogleThinkingLevel(
  model: Model<"google-generative-ai">,
  level: ModelThinkingLevel,
): ResolvedThinkingLevel {
  if (level === "off") return "high";

  const mapped = model.thinkingLevelMap?.[level];
  const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
  switch (resolvedLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
      return resolvedLevel;
    default:
      throw new Error(
        `Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
      );
  }
}

/**
 * `thought` marks a thought summary. A thought signature preserves reasoning context, but it can
 * appear on any part and does not make that part a thought summary.
 */
function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
  return part.thought === true;
}

/** Preserve a signature when later streaming deltas omit it. */
function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  return typeof incoming === "string" && incoming.length > 0 ? incoming : existing;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
  return (
    signature !== undefined &&
    signature.length > 0 &&
    signature.length % 4 === 0 &&
    base64SignaturePattern.test(signature)
  );
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function requiresToolCallId(modelId: string): boolean {
  const majorVersion = getGeminiMajorVersion(modelId);
  return majorVersion !== undefined && majorVersion >= 3;
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const majorVersion = getGeminiMajorVersion(modelId);
  return majorVersion === undefined || majorVersion >= 3;
}

function convertMessages(model: Model<"google-generative-ai">, context: Context): Content[] {
  const contents: Content[] = [];
  const normalizeToolCallId = (id: string): string => {
    if (!requiresToolCallId(model.id)) return id;
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  for (const message of transformedMessages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeSurrogates(message.content) }],
        });
      } else {
        const parts: Part[] = message.content.map((item) =>
          item.type === "text"
            ? { text: sanitizeSurrogates(item.text) }
            : { inlineData: { mimeType: item.mimeType, data: item.data } },
        );
        if (parts.length > 0) {
          contents.push({ role: "user", parts });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: Part[] = [];
      const isSameProviderAndModel =
        message.provider === model.provider && message.model === model.id;

      for (const block of message.content) {
        if (block.type === "text") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          if (block.text.trim() === "" && !thoughtSignature) continue;
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...(thoughtSignature && { thoughtSignature }),
          });
          continue;
        }

        if (block.type === "thinking") {
          if (isSameProviderAndModel) {
            const thoughtSignature = resolveThoughtSignature(
              isSameProviderAndModel,
              block.thinkingSignature,
            );
            if (block.thinking.trim() === "" && !thoughtSignature) continue;
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              ...(thoughtSignature && { thoughtSignature }),
            });
          } else if (block.thinking.trim() !== "") {
            parts.push({ text: sanitizeSurrogates(block.thinking) });
          }
          continue;
        }

        const thoughtSignature = resolveThoughtSignature(
          isSameProviderAndModel,
          block.thoughtSignature,
        );
        parts.push({
          functionCall: {
            name: block.name,
            args: block.arguments ?? {},
            ...(requiresToolCallId(model.id) && { id: block.id }),
          },
          ...(thoughtSignature && { thoughtSignature }),
        });
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    const textResult = message.content
      .filter((content): content is TextContent => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const imageContent = model.input.includes("image")
      ? message.content.filter((content): content is ImageContent => content.type === "image")
      : [];
    const hasImages = imageContent.length > 0;
    const supportsMultimodalResponse = supportsMultimodalFunctionResponse(model.id);
    const responseValue =
      textResult.length > 0
        ? sanitizeSurrogates(textResult)
        : hasImages
          ? "(see attached image)"
          : "";
    const imageParts: Part[] = imageContent.map((image) => ({
      inlineData: { mimeType: image.mimeType, data: image.data },
    }));
    const functionResponsePart: Part = {
      functionResponse: {
        name: message.toolName,
        response: message.isError ? { error: responseValue } : { output: responseValue },
        ...(hasImages && supportsMultimodalResponse && { parts: imageParts }),
        ...(requiresToolCallId(model.id) && { id: message.toolCallId }),
      },
    };

    const lastContent = contents[contents.length - 1];
    if (lastContent?.role === "user" && lastContent.parts?.some((part) => part.functionResponse)) {
      lastContent.parts.push(functionResponsePart);
    } else {
      contents.push({ role: "user", parts: [functionResponsePart] });
    }

    if (hasImages && !supportsMultimodalResponse) {
      contents.push({
        role: "user",
        parts: [{ text: "Tool result image:" }, ...imageParts],
      });
    }
  }

  return contents;
}

function convertTools(
  tools: Tool[],
  supportsStrictMode: boolean,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
        return {
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: getJsonSchemaToolParameters(tool, strict),
        };
      }),
    },
  ];
}

function supportsGoogleStrictToolSampling(modelId: string): boolean {
  const majorVersion = getGeminiMajorVersion(modelId);
  return majorVersion !== undefined && majorVersion >= 3;
}

function resolveGoogleFunctionCallingMode(
  tools: Tool[],
  toolChoice: GoogleOptions["toolChoice"],
  supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
  if (toolChoice === "none") return FunctionCallingConfigMode.NONE;
  if (toolChoice === "any") return FunctionCallingConfigMode.ANY;
  if (tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode))) {
    return FunctionCallingConfigMode.VALIDATED;
  }
  return toolChoice === "auto" ? FunctionCallingConfigMode.AUTO : undefined;
}

function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled stop reason: ${exhaustive}`);
    }
  }
}

function retryGoogleRequest<T>(
  request: () => Promise<T>,
  options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
  return retryProviderRequest(
    async () => {
      try {
        return await request();
      } catch (error) {
        // The Google SDK exposes a status without headers. Add the missing field so the common
        // retry policy can classify the error.
        if (error instanceof Error && "status" in error && !("headers" in error)) {
          (error as { headers?: Headers }).headers = undefined;
        }
        throw error;
      }
    },
    {
      maxRetries: options?.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      signal: options?.signal,
    },
  );
}
