/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/test/harness/context.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BACKGROUND_CONTEXT,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
  withoutAbortSignal,
} from "../src/harness/context.ts";

void describe("Context", () => {
  void test("layers typed values without modifying parents", () => {
    const firstKey = createContextKey<string>("first");
    const secondKey = createContextKey<number>("second");
    const first = withContextValue(firstKey, "one", BACKGROUND_CONTEXT);
    const second = withContextValue(secondKey, 2, first);
    const replaced = withContextValue(firstKey, "updated", second);

    assert.equal(BACKGROUND_CONTEXT.value(firstKey), undefined);
    assert.equal(first.value(firstKey), "one");
    assert.equal(first.value(secondKey), undefined);
    assert.equal(second.value(firstKey), "one");
    assert.equal(second.value(secondKey), 2);
    assert.equal(replaced.value(firstKey), "updated");
    assert.equal(second.value(firstKey), "one");
    assert.equal(
      String(replaced),
      "[Context BACKGROUND_CONTEXT].WithValue(first).WithValue(second).WithValue(first)",
    );
  });

  void test("inherits parent cancellation and isolates child cancellation", () => {
    const parentController = new AbortController();
    const parent = withAbortSignal(parentController.signal, BACKGROUND_CONTEXT);
    const child = withCancel(parent);
    const sibling = withCancel(parent);
    let childAborts = 0;
    child.context.abortSignal?.addEventListener("abort", () => {
      childAborts += 1;
    });

    child.cancel("child");
    assert.equal(child.context.abortSignal?.aborted, true);
    assert.equal(child.context.abortSignal?.reason, "child");
    assert.equal(sibling.context.abortSignal?.aborted, false);
    assert.equal(parent.abortSignal?.aborted, false);
    assert.equal(childAborts, 1);

    parentController.abort("parent");
    assert.equal(sibling.context.abortSignal?.aborted, true);
    assert.equal(sibling.context.abortSignal?.reason, "parent");
  });

  void test("masks caller cancellation for mandatory cleanup", () => {
    const controller = new AbortController();
    const key = createContextKey<string>("value");
    const context = withContextValue(
      key,
      "preserved",
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    const cleanup = withoutAbortSignal(context);

    controller.abort();
    assert.equal(context.abortSignal?.aborted, true);
    assert.equal(cleanup.abortSignal, undefined);
    assert.equal(cleanup.value(key), "preserved");
  });
});
