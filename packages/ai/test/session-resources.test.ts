import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acquireSessionResources,
  registerSessionResourceCleanup,
} from "../src/session-resources.ts";

void describe("provider session resource leases", () => {
  void test("cleans a session only after its last harness releases it", () => {
    const cleaned: Array<string | undefined> = [];
    const unregister = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
    try {
      const releaseFirst = acquireSessionResources("session-1");
      const releaseSecond = acquireSessionResources("session-1");

      releaseFirst();
      releaseFirst();
      assert.deepEqual(cleaned, []);
      releaseSecond();
      assert.deepEqual(cleaned, ["session-1"]);
    } finally {
      unregister();
    }
  });

  void test("tracks different sessions independently", () => {
    const cleaned: Array<string | undefined> = [];
    const unregister = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
    try {
      const releaseFirst = acquireSessionResources("session-1");
      const releaseSecond = acquireSessionResources("session-2");

      releaseSecond();
      releaseFirst();
      assert.deepEqual(cleaned, ["session-2", "session-1"]);
    } finally {
      unregister();
    }
  });
});
