/**
 * Example question tool over durable suspension. The model calls `question`;
 * the call parks the run (design record, "Suspension and wake") and the
 * pending tool call itself is what a client renders: its arguments carry the
 * question and the options. The user answers through the reply channel
 * (`runs.reply`), which targets this call directly; conversation messages are
 * never involved, so an unrelated steer can never be mistaken for an answer.
 *
 * A reply that names an option (its number or its label) selects it; any
 * other reply is the user's own answer, so a human is never trapped in the
 * answers the model imagined.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/question.ts
 * The own-answer rule follows https://github.com/anomalyco/opencode/blob/e70d667a9fe3e84cc071a5596aa522c142c525b7/packages/core/src/tool/plugin/question.ts
 */
import { definePlugin, ToolWait } from "@uji-ai/plugin";
import type { HarnessTool } from "@uji-ai/plugin";
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

/** A reply names an option by 1-based number or exact label; anything else is its own answer. */
export function answerFor(input: QuestionInput, reply: string): string {
  const trimmed = reply.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= input.options.length) {
    const selected = input.options[index - 1];
    if (selected !== undefined) return selected.label;
  }
  const lowered = trimmed.toLowerCase();
  const byLabel = input.options.find((option) => option.label.toLowerCase() === lowered);
  return byLabel?.label ?? trimmed;
}

export const questionTool: HarnessTool = {
  name: "question",
  description:
    "Ask the user one question and let them choose from a list of answers. " +
    "The user may also answer in their own words; you receive whichever they gave.",
  parameters: questionParameters,
  replay: "never",
  async execute(_toolCallId, rawParams) {
    parseQuestionInput(rawParams);
    throw new ToolWait();
  },
  wake: async (suspension, context) => {
    const input = parseQuestionInput(suspension.args);
    if (context.reply === undefined) return { kind: "wait" };
    const answer = typeof context.reply === "string" ? answerFor(input, context.reply) : "";
    if (answer === "") {
      // An empty or malformed reply is a human walking away, not an answer.
      return {
        kind: "settle",
        isError: true,
        result: {
          content: [{ type: "text", text: "Question was left unanswered" }],
          details: { question: input.question },
          title: input.question,
        },
      };
    }
    return {
      kind: "settle",
      result: {
        content: [{ type: "text", text: answer }],
        details: { question: input.question, answer },
        title: input.question,
      },
    };
  },
};

export const questionPlugin = definePlugin({
  id: "question",
  session(api) {
    api.tools.add((draft) => draft.set(questionTool.name, questionTool));
  },
});

export default questionPlugin;
