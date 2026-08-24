/**
 * Example question tool. The model calls `question`; the plugin asks the
 * attached client to render a choice and returns the answer as a tool result.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/question.ts
 */
import { definePlugin } from "@uji-ai/plugin";
import type { AskRequest, HarnessTool } from "@uji-ai/plugin";
import { Unsafe } from "typebox";

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionInput {
  question: string;
  options: QuestionOption[];
}

const questionParameters = Unsafe<QuestionInput>({
  type: "object",
  properties: {
    question: { type: "string", description: "The question to ask the user" },
    options: {
      type: "array",
      minItems: 1,
      description: "Choices the user can select",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Display label for the option" },
          description: { type: "string", description: "Extra detail shown under the label" },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
  },
  required: ["question", "options"],
  additionalProperties: false,
});

function parseQuestionOption(value: unknown, index: number): QuestionOption {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Question option ${String(index + 1)} must be an object`);
  }
  const label = "label" in value ? value.label : undefined;
  const description = "description" in value ? value.description : undefined;
  if (typeof label !== "string" || label === "") {
    throw new Error(`Question option ${String(index + 1)} needs a label`);
  }
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Question option ${String(index + 1)} has an invalid description`);
  }
  return description === undefined ? { label } : { label, description };
}

function parseQuestionInput(value: unknown): QuestionInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("Question arguments must be an object");
  }
  const question = "question" in value ? value.question : undefined;
  const options = "options" in value ? value.options : undefined;
  if (typeof question !== "string" || question === "") {
    throw new Error("Question text is required");
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("Question needs at least one option");
  }
  return { question, options: options.map(parseQuestionOption) };
}

type AskSelect = (request: Extract<AskRequest, { kind: "select" }>) => Promise<string>;

export function createQuestionTool(ask: AskSelect): HarnessTool {
  return {
    name: "question",
    label: "Question",
    description: "Ask the user one question and let them choose from a list of answers.",
    parameters: questionParameters,
    replay: "never",
    async execute(_toolCallId, rawParams) {
      const params = parseQuestionInput(rawParams);
      const request = {
        kind: "select",
        title: params.question,
        options: params.options.map((option, index) => ({
          value: String(index),
          label: option.label,
          description: option.description,
        })),
      } satisfies AskRequest;
      const answer = await ask(request);
      const selected = params.options[Number(answer)];
      if (selected === undefined) throw new Error("Question returned an unknown choice");
      return {
        content: [{ type: "text", text: selected.label }],
        details: { question: params.question, answer: selected.label },
      };
    },
  };
}

export const questionPlugin = definePlugin({
  id: "question",
  session(api) {
    const tool = createQuestionTool(api.ask);
    api.tools.add((draft) => draft.set(tool.name, tool));
  },
});

export default questionPlugin;
