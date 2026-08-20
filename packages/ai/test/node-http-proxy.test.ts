/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/node-http-proxy.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  resolveHttpProxyUrlForTarget,
  UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
} from "../src/utils/node-http-proxy.ts";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "npm_config_http_proxy",
  "npm_config_https_proxy",
  "npm_config_proxy",
  "npm_config_no_proxy",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of PROXY_ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

function resetProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  resetProxyEnv();
  for (const [key, value] of originalEnv) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
});

void describe("node HTTP proxy resolution", () => {
  void test("respects NO_PROXY exclusions", () => {
    resetProxyEnv();
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "bedrock-runtime.us-east-1.amazonaws.com";

    assert.equal(
      resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com"),
      undefined,
    );
  });

  void test("resolves HTTP and HTTPS proxy URLs", () => {
    resetProxyEnv();
    process.env.HTTPS_PROXY = "http://proxy.example:8080";

    assert.equal(
      resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")?.toString(),
      "http://proxy.example:8080/",
    );
  });

  void test("prefers scoped proxy env aliases before process env aliases", () => {
    resetProxyEnv();
    process.env.https_proxy = "http://process-proxy.example:8080";

    assert.equal(
      resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com", {
        HTTPS_PROXY: "http://scoped-proxy.example:8080",
      })?.toString(),
      "http://scoped-proxy.example:8080/",
    );
  });

  void test("rejects SOCKS and PAC proxy URLs explicitly", () => {
    resetProxyEnv();
    process.env.HTTPS_PROXY = "socks5://proxy.example:1080";

    assert.throws(
      () => resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com"),
      new RegExp(UNSUPPORTED_PROXY_PROTOCOL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});
