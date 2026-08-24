import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { OPENAI_CODEX_MODELS } from "../src/providers/openai-codex.models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";

function modelIdsWithMode(
  models: Readonly<Record<string, { id: string; modes?: readonly "fast"[] }>>,
): string[] {
  return Object.values(models)
    .filter((model) => model.modes?.includes("fast") === true)
    .map((model) => model.id)
    .sort();
}

describe("generated model modes", () => {
  test("advertises fast mode only on first-party Anthropic models", () => {
    const fast = Object.values(ANTHROPIC_MODELS).filter(
      (model) => model.modes?.includes("fast") === true,
    );
    assert.ok(fast.length > 0);
    assert.equal(
      fast.every((model) => model.provider === "anthropic"),
      true,
    );
  });

  test("inherits the authoritative OpenAI fast models in the Codex catalog", () => {
    const openaiFast = modelIdsWithMode(OPENAI_MODELS);
    assert.ok(openaiFast.length > 0);
    assert.deepEqual(modelIdsWithMode(OPENAI_CODEX_MODELS), openaiFast);
  });
});
