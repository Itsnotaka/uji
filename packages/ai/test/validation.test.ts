/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/validation.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Tool, ToolCall } from "@june/schema";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
  schema: Tool["parameters"],
  value: unknown,
): {
  tool: Tool;
  toolCall: ToolCall;
} {
  const tool: Tool = {
    name: "echo",
    description: "Echo tool",
    parameters: {
      type: "object",
      properties: {
        value: schema,
      },
      required: ["value"],
    } as Tool["parameters"],
  };

  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tool-1",
    name: "echo",
    arguments: { value },
  };

  return { tool, toolCall };
}

void describe("validateToolArguments", () => {
  void test("still validates when Function constructor is unavailable", () => {
    const originalFunction = globalThis.Function;
    const tool: Tool = {
      name: "echo",
      description: "Echo tool",
      parameters: Type.Object({
        count: Type.Number(),
      }),
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tool-1",
      name: "echo",
      arguments: { count: "42" as unknown as number },
    };

    globalThis.Function = (() => {
      throw new EvalError("Code generation from strings disallowed for this context");
    }) as unknown as FunctionConstructor;

    try {
      assert.deepEqual(validateToolArguments(tool, toolCall), { count: 42 });
    } finally {
      globalThis.Function = originalFunction;
    }
  });

  void test("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
    const passingCases: Array<{
      schema: Tool["parameters"];
      input: unknown;
      expected: unknown;
    }> = [
      { schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
      { schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
      { schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
      { schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
      { schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
      { schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
      { schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
      { schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
      { schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
      { schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
      { schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
      { schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
      { schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
      {
        schema: { type: ["number", "string"] } as Tool["parameters"],
        input: "1",
        expected: "1",
      },
      {
        schema: { type: ["boolean", "number"] } as Tool["parameters"],
        input: "1",
        expected: 1,
      },
    ];

    for (const testCase of passingCases) {
      const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
      assert.deepEqual(validateToolArguments(tool, toolCall), { value: testCase.expected });
    }
  });

  void test("treats null as omission for optional non-nullable properties", () => {
    const tool: Tool = {
      name: "echo",
      description: "Echo tool",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
      }),
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tool-1",
      name: "echo",
      arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
    };

    assert.deepEqual(validateToolArguments(tool, toolCall), {
      path: "file.txt",
      nullable: null,
      metadata: {},
    });
  });

  void test("preserves optional nulls whose referenced schema is nullable", () => {
    const tool: Tool = {
      name: "echo",
      description: "Echo tool",
      parameters: {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
      } as Tool["parameters"],
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tool-1",
      name: "echo",
      arguments: { value: null },
    };

    assert.deepEqual(validateToolArguments(tool, toolCall), { value: null });
  });

  void test("preserves a value that already matches a nullable union arm", () => {
    const tool: Tool = {
      name: "echo",
      description: "Echo tool",
      parameters: Type.Object({
        value: Type.Union([Type.Number(), Type.Null()]),
      }),
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tool-1",
      name: "echo",
      arguments: { value: null },
    };

    assert.deepEqual(validateToolArguments(tool, toolCall), { value: null });
  });

  void test("preserves a value that already matches a oneOf nullable union arm", () => {
    const { tool, toolCall } = createToolCallWithPlainSchema(
      { oneOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
      null,
    );

    assert.deepEqual(validateToolArguments(tool, toolCall), { value: null });
  });

  void test("still coerces nullable unions when the original value does not match any arm", () => {
    const { tool, toolCall } = createToolCallWithPlainSchema(
      { anyOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
      "42",
    );

    assert.deepEqual(validateToolArguments(tool, toolCall), { value: 42 });
  });

  void test("accepts null for nullable array schemas with items", () => {
    const { tool, toolCall } = createToolCallWithPlainSchema(
      { type: ["array", "null"], items: { type: "string" } } as Tool["parameters"],
      null,
    );
    // The CSP test above selects TypeBox's process-wide interpreted fallback, so exercise the generated validator explicitly.
    // oxlint-disable-next-line no-implied-eval -- exercises TypeBox's generated validator, as pi's test does
    const generatedCheck = new Function(Compile(tool.parameters).Code())() as (
      value: unknown,
    ) => boolean;

    assert.equal(generatedCheck(toolCall.arguments), true);
    assert.deepEqual(validateToolArguments(tool, toolCall), { value: null });
  });

  void test("rejects invalid coercions for serialized plain JSON schemas", () => {
    const failingCases: Array<{
      schema: Tool["parameters"];
      input: unknown;
    }> = [
      { schema: { type: "boolean" } as Tool["parameters"], input: "1" },
      { schema: { type: "boolean" } as Tool["parameters"], input: "0" },
      { schema: { type: "null" } as Tool["parameters"], input: "null" },
      { schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
    ];

    for (const testCase of failingCases) {
      const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
      assert.throws(() => validateToolArguments(tool, toolCall), /Validation failed/);
    }
  });
});
