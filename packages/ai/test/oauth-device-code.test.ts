/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/oauth-device-code.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { pollOAuthDeviceCodeFlow } from "../src/auth/oauth/device-code.ts";

const neverAbortedSignal = new AbortController().signal;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await flush();
}

void describe("OAuth device-code polling", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  void test("polls immediately and returns the completed value", async () => {
    const start = new Date("2026-03-09T00:00:00Z").getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });

    const pollTimes: number[] = [];
    const poll = async () => {
      pollTimes.push(Date.now());
      return pollTimes.length === 1
        ? { status: "pending" as const }
        : { status: "complete" as const, value: "token" };
    };

    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 2,
      expiresInSeconds: 30,
      poll,
      signal: neverAbortedSignal,
    });

    await advance(0);
    assert.deepEqual(pollTimes, [start]);

    await advance(1999);
    assert.deepEqual(pollTimes, [start]);

    await advance(1);
    assert.equal(await resultPromise, "token");
    assert.deepEqual(pollTimes, [start, start + 2000]);
  });

  void test("can wait before the first poll", async () => {
    const start = new Date("2026-03-09T00:00:00Z").getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });

    const pollTimes: number[] = [];
    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 2,
      expiresInSeconds: 30,
      waitBeforeFirstPoll: true,
      poll: async () => {
        pollTimes.push(Date.now());
        return { status: "complete" as const, value: "token" };
      },
      signal: neverAbortedSignal,
    });

    await advance(1999);
    assert.deepEqual(pollTimes, []);

    await advance(1);
    assert.equal(await resultPromise, "token");
    assert.deepEqual(pollTimes, [start + 2000]);
  });

  void test("increases the interval by 5 seconds after slow_down without a server interval", async () => {
    const startTime = new Date("2026-03-09T00:00:00Z").getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: startTime });

    const pollTimes: number[] = [];
    const results = [
      { status: "slow_down" as const },
      { status: "complete" as const, value: "token" },
    ];
    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 2,
      expiresInSeconds: 900,
      poll: async () => {
        pollTimes.push(Date.now());
        const result = results.shift();
        if (!result) throw new Error("Unexpected extra poll");
        return result;
      },
      signal: neverAbortedSignal,
    });

    await advance(0);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(6999);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(1);
    assert.equal(await resultPromise, "token");
    assert.deepEqual(pollTimes, [startTime, startTime + 7000]);
  });

  void test("honors a server-provided slow_down interval", async () => {
    const startTime = new Date("2026-03-09T00:00:00Z").getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: startTime });

    const pollTimes: number[] = [];
    const results = [
      { status: "slow_down" as const, intervalSeconds: 30 },
      { status: "complete" as const, value: "token" },
    ];
    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 2,
      expiresInSeconds: 900,
      poll: async () => {
        pollTimes.push(Date.now());
        const result = results.shift();
        if (!result) throw new Error("Unexpected extra poll");
        return result;
      },
      signal: neverAbortedSignal,
    });

    await advance(0);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(29999);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(1);
    assert.equal(await resultPromise, "token");
    assert.deepEqual(pollTimes, [startTime, startTime + 30000]);
  });

  void test("cancels an in-flight wait", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const controller = new AbortController();

    const resultPromise = pollOAuthDeviceCodeFlow({
      intervalSeconds: 5,
      expiresInSeconds: 30,
      poll: async () => ({ status: "pending" }),
      signal: controller.signal,
    });

    controller.abort();
    await assert.rejects(resultPromise, { message: "Login cancelled" });
  });
});
