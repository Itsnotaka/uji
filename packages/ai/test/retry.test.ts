/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/retry.test.ts
 * Synced with pi 7ebf9087e.
 *
 * Uji divergence: pi builds messages with `fauxAssistantMessage` from
 * `providers/faux.ts`; that provider is ported with the registry, so a local
 * builder with the same signature stands in here.
 */
import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import type { AssistantMessage } from "@uji-ai/schema";
import {
  isRetryableAssistantError,
  type RetryPolicy,
  retryAssistantCall,
} from "../src/utils/retry.ts";

function fauxAssistantMessage(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

const openAIExplicitRetryMessage =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
  '{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage =
  "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
  "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage =
  "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
  "The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";

function errorMessage(text: string): AssistantMessage {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
}

void describe("provider retry classification", () => {
  void test("matches explicit provider retry guidance", () => {
    assert.equal(isRetryableAssistantError(errorMessage(openAIExplicitRetryMessage)), true);
    assert.equal(isRetryableAssistantError(errorMessage(bedrockExplicitRetryMessage)), true);
    assert.equal(isRetryableAssistantError(errorMessage(nvidiaNIMResourceExhaustedMessage)), true);
  });

  void test("matches Bun fetch socket drop wording", () => {
    assert.equal(isRetryableAssistantError(errorMessage(bunFetchSocketClosedMessage)), true);
  });

  void test("matches upstream request buffer exhaustion wording", () => {
    assert.equal(
      isRetryableAssistantError(
        errorMessage("Error: exceeded request buffer limit while retrying upstream"),
      ),
      true,
    );
  });

  for (const text of [
    wrappedDnsLookupError,
    "connect ENOTFOUND api.example.com",
    "EAI_AGAIN api.example.com",
    "getaddrinfo failed for api.example.com",
  ]) {
    void test(`matches DNS transport failure wording: ${text}`, () => {
      assert.equal(isRetryableAssistantError(errorMessage(text)), true);
    });
  }

  void test("matches OpenAI Responses streams that end before terminal events", () => {
    assert.equal(isRetryableAssistantError(errorMessage(openAIResponsesEarlyEofMessage)), true);
  });

  void test("keeps provider limit errors non-retryable", () => {
    assert.equal(isRetryableAssistantError(errorMessage("429 quota exceeded")), false);
  });

  void test("classifies assistant error messages", () => {
    assert.equal(isRetryableAssistantError(errorMessage("overloaded_error")), true);
    assert.equal(isRetryableAssistantError(errorMessage("524 status code (no body)")), true);
    assert.equal(isRetryableAssistantError(fauxAssistantMessage("not an error")), false);
  });
});

void describe("retryAssistantCall", () => {
  const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
  const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

  void test("returns a successful response immediately without retrying", async () => {
    const produce = mock.fn(async () => fauxAssistantMessage("ok"));
    const res = await retryAssistantCall(produce, enabled, undefined);
    assert.deepEqual(res.content, [{ type: "text", text: "ok" }]);
    assert.equal(produce.mock.callCount(), 1);
  });

  void test("does not retry an aborted message", async () => {
    const produce = mock.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
    const onRetryScheduled = mock.fn();
    const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
    assert.equal(res.stopReason, "aborted");
    assert.equal(produce.mock.callCount(), 1);
    assert.equal(onRetryScheduled.mock.callCount(), 0);
  });

  void test("does not retry a non-retryable error (quota/billing)", async () => {
    const produce = mock.fn(async () => errorMessage("insufficient_quota"));
    const onRetryScheduled = mock.fn();
    const onRetryFinished = mock.fn();
    const res = await retryAssistantCall(produce, enabled, undefined, {
      onRetryScheduled,
      onRetryFinished,
    });
    assert.equal(res.stopReason, "error");
    assert.equal(produce.mock.callCount(), 1);
    assert.equal(onRetryScheduled.mock.callCount(), 0);
    assert.equal(onRetryFinished.mock.callCount(), 0);
  });

  void test("retries a transient error up to maxRetries then returns the final error", async () => {
    const produce = mock.fn(async () => errorMessage("terminated"));
    const onRetryScheduled = mock.fn();
    const onRetryFinished = mock.fn();
    const res = await retryAssistantCall(produce, enabled, undefined, {
      onRetryScheduled,
      onRetryFinished,
    });
    assert.equal(res.stopReason, "error");
    assert.equal(produce.mock.callCount(), 4); // 1 initial + 3 retries
    assert.equal(onRetryScheduled.mock.callCount(), 3);
    assert.deepEqual(onRetryFinished.mock.calls.at(-1)?.arguments, [false, 3, "terminated"]);
  });

  void test("stops retrying once a call succeeds", async () => {
    let n = 0;
    const produce = mock.fn(async () => {
      n++;
      return n < 3 ? errorMessage("terminated") : fauxAssistantMessage("recovered");
    });
    const onRetryFinished = mock.fn();
    const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
    assert.deepEqual(res.content, [{ type: "text", text: "recovered" }]);
    assert.equal(produce.mock.callCount(), 3);
    assert.deepEqual(onRetryFinished.mock.calls.at(-1)?.arguments, [true, 2]);
  });

  void test("reports an aborted retried call as unsuccessful", async () => {
    let n = 0;
    const produce = mock.fn(async () => {
      n++;
      return n === 1
        ? errorMessage("terminated")
        : fauxAssistantMessage("", { stopReason: "aborted" });
    });
    const onRetryFinished = mock.fn();
    const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
    assert.equal(res.stopReason, "aborted");
    assert.equal(produce.mock.callCount(), 2);
    assert.deepEqual(onRetryFinished.mock.calls.at(-1)?.arguments, [false, 1]);
  });

  void test("does not retry when policy is disabled", async () => {
    const produce = mock.fn(async () => errorMessage("terminated"));
    const onRetryScheduled = mock.fn();
    const onRetryFinished = mock.fn();
    const res = await retryAssistantCall(produce, disabled, undefined, {
      onRetryScheduled,
      onRetryFinished,
    });
    assert.equal(res.stopReason, "error");
    assert.equal(produce.mock.callCount(), 1);
    assert.equal(onRetryScheduled.mock.callCount(), 0);
    assert.equal(onRetryFinished.mock.callCount(), 0);
  });

  void test("emits onRetryAttemptStart after backoff before each retried call", async () => {
    const events: string[] = [];
    let n = 0;
    const produce = mock.fn(async () => {
      events.push(`produce:${n}`);
      n++;
      return n < 3 ? errorMessage("terminated") : fauxAssistantMessage("recovered");
    });
    const onRetryScheduled = mock.fn((attempt: number) => {
      events.push(`retry:${attempt}`);
    });
    const onRetryAttemptStart = mock.fn(() => {
      events.push("attempt-start");
    });
    const res = await retryAssistantCall(produce, enabled, undefined, {
      onRetryScheduled,
      onRetryAttemptStart,
    });
    assert.deepEqual(res.content, [{ type: "text", text: "recovered" }]);
    assert.equal(onRetryScheduled.mock.callCount(), 2);
    assert.equal(onRetryAttemptStart.mock.callCount(), 2);
    assert.deepEqual(events, [
      "produce:0",
      "retry:1",
      "attempt-start",
      "produce:1",
      "retry:2",
      "attempt-start",
      "produce:2",
    ]);
  });

  void test("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
    const controller = new AbortController();
    const produce = mock.fn(async () => errorMessage("terminated"));
    const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
    const onRetryFinished = mock.fn();
    const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
    // Let one error call resolve and the first backoff sleep start, then abort.
    while (produce.mock.callCount() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    const res = await p;
    assert.equal(res.stopReason, "aborted");
    assert.equal(res.errorMessage, undefined);
    assert.equal(produce.mock.callCount(), 1);
    assert.deepEqual(onRetryFinished.mock.calls.at(-1)?.arguments, [false, 1, "terminated"]);
  });
});
