import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toJsonValue } from "../src/harness/session/types.ts";

describe("toJsonValue", () => {
  test("drops undefined object properties like JSON.stringify", () => {
    // Tool prepareArguments return `{ path, offset, limit }` with omitted optionals.
    assert.deepEqual(toJsonValue({ path: "a.ts", offset: undefined, limit: undefined }), {
      path: "a.ts",
    });
  });

  test("still rejects undefined array elements", () => {
    assert.throws(() => toJsonValue([1, undefined]), /cannot be represented as JSON/);
  });

  test("still rejects non-JSON scalars", () => {
    assert.throws(() => toJsonValue({ a: () => 1 }), /\$\.a cannot be represented as JSON/);
  });
});
