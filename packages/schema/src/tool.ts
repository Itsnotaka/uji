/**
 * What the model is told it can call, and the context one provider request is
 * built from. Parameters are a TypeBox schema so one declaration gives the
 * provider its JSON Schema, the tool its argument type, and the harness its
 * runtime validation.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/types.ts
 * Synced with pi 7ebf9087e.
 */
import type { TSchema } from "typebox";
import type { JsonValue, Message } from "./message.ts";
import type { Api, ProviderId } from "./model.ts";

/** OpenAI grammar variants for constrained sampling. */
export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * Optional provider-side constrained sampling configs for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs. Grammar variants let
 * callers provide provider-specific encodings of the same intended language.
 */
export type ConstrainedSamplingConfig =
  | {
      type: "json_schema";
      strict: "prefer" | "require";
    }
  | {
      type: "grammar";
      variants: GrammarVariants;
    };

/**
 * What a tool does, in the categories the Agent Client Protocol uses, so a
 * client can render a tool it has never seen. Defaults to "other".
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "think"
  | "other";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  kind?: ToolKind;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

/** Opaque context material that only its producing provider/API/model may replay. */
export interface ProviderCheckpointMaterial {
  type: "provider";
  provider: ProviderId;
  api: Api;
  model: string;
  data: JsonValue;
}

/** One provider request: system prompt, optional native checkpoint, history, and tools. */
export interface Context {
  systemPrompt?: string;
  checkpoint?: ProviderCheckpointMaterial;
  /** Conversation items appended after `checkpoint`, or the complete portable history. */
  messages: Message[];
  tools?: Tool[];
}
