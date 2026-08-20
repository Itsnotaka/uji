/**
 * Unit tests for the shared provider error-body normalizer: one synthesized
 * error object per SDK shape, the non-Error fallback, truncation, the empty
 * parsed-body edge case, and the formatProviderError compose helper.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/error-body.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatProviderError,
  MAX_PROVIDER_ERROR_BODY_CHARS,
  normalizeProviderError,
} from "../src/utils/error-body.ts";

void describe("normalizeProviderError", () => {
  void test("extracts status and body from a Mistral-shaped error", () => {
    const error = Object.assign(new Error("Mistral request failed"), {
      statusCode: 403,
      body: '{"error":"blocked by gateway WAF"}',
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 403);
    assert.equal(norm.body, '{"error":"blocked by gateway WAF"}');
    assert.equal(norm.messageCarriesBody, false);
  });

  void test("reads the parsed body off an openai APIError when the message is opaque", () => {
    const error = Object.assign(new Error("403 status code (no body)"), {
      status: 403,
      error: { error: "blocked by gateway WAF" },
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 403);
    assert.equal(norm.body, '{"error":"blocked by gateway WAF"}');
    assert.equal(norm.messageCarriesBody, false);
  });

  void test("preserves the message when @google/genai already folds the body into it", () => {
    const body = { error: { code: 403, message: "Permission denied" } };
    const error = Object.assign(new Error(JSON.stringify(body)), { status: 403 });

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 403);
    assert.equal(norm.messageCarriesBody, true);
    assert.equal(norm.message, JSON.stringify(body));
  });

  void test("extracts status and body from a Bedrock-shaped ServiceException", () => {
    const error = Object.assign(new Error("UnknownError"), {
      name: "UnknownError",
      $metadata: { httpStatusCode: 403 },
      $response: { statusCode: 403, body: '{"message":"blocked by gateway WAF"}' },
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 403);
    assert.equal(norm.body, '{"message":"blocked by gateway WAF"}');
    assert.equal(norm.messageCarriesBody, false);
  });

  void test("ignores a Bedrock response stream instead of serializing its internals", () => {
    const error = Object.assign(
      new Error(
        "Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported.",
      ),
      {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400 },
        $response: {
          statusCode: 400,
          body: { pipe: () => undefined, _events: { close: [null, null] } },
        },
      },
    );

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 400);
    assert.equal(norm.body, undefined);
    assert.ok(norm.message.includes("on-demand throughput isn't supported"));
    assert.equal(norm.messageCarriesBody, true);
  });

  void test("ignores a class-instance response body without a pipe method instead of serializing it", () => {
    class SdkHttpResponseBody {
      locked = false;
      state = { storedError: undefined };
    }
    const error = Object.assign(new Error("Input is too long for requested model."), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
      $response: { statusCode: 400, body: new SdkHttpResponseBody() },
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.status, 400);
    assert.equal(norm.body, undefined);
    assert.ok(norm.message.includes("Input is too long"));
    assert.equal(norm.messageCarriesBody, true);
  });

  void test("ignores a class-instance `error` field instead of serializing it", () => {
    class SdkInnerError {
      code = "EPROTO";
      internalState = {};
    }
    const error = Object.assign(new Error("TLS handshake failed"), {
      status: 502,
      error: new SdkInnerError(),
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.body, undefined);
    assert.equal(norm.message, "TLS handshake failed");
    assert.equal(norm.messageCarriesBody, true);
  });

  void test("still surfaces a plain parsed JSON body object", () => {
    const error = Object.assign(new Error("400 status code (no body)"), {
      status: 400,
      error: { message: "schema validation failed", field: "tools[0]" },
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.body, '{"message":"schema validation failed","field":"tools[0]"}');
    assert.equal(norm.messageCarriesBody, false);
  });

  void test("JSON-stringifies a non-Error thrown value", () => {
    const norm = normalizeProviderError({ reason: "boom" });

    assert.equal(norm.status, undefined);
    assert.equal(norm.body, undefined);
    assert.equal(norm.message, '{"reason":"boom"}');
    assert.equal(norm.messageCarriesBody, false);
  });

  void test("treats an empty parsed body object as no body", () => {
    const error = Object.assign(new Error("403 status code (no body)"), { status: 403, error: {} });

    const norm = normalizeProviderError(error);

    assert.equal(norm.body, undefined);
    assert.equal(norm.messageCarriesBody, true);
  });

  void test("truncates the body at the cap", () => {
    const longBody = "x".repeat(MAX_PROVIDER_ERROR_BODY_CHARS + 50);
    const error = Object.assign(new Error("failed"), { statusCode: 500, body: longBody });

    const norm = normalizeProviderError(error);

    assert.ok(norm.body?.includes("... [truncated 50 chars]"));
    assert.ok((norm.body?.length ?? Number.POSITIVE_INFINITY) < longBody.length);
  });

  void test("sets messageCarriesBody when the message already contains the extracted body", () => {
    const error = Object.assign(new Error("500: upstream exploded"), {
      statusCode: 500,
      body: "upstream exploded",
    });

    const norm = normalizeProviderError(error);

    assert.equal(norm.messageCarriesBody, true);
  });
});

void describe("formatProviderError", () => {
  void test("surfaces status and body without a prefix", () => {
    const norm = normalizeProviderError(
      Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { error: "blocked by gateway WAF" },
      }),
    );

    const formatted = formatProviderError(norm);

    assert.ok(formatted.includes("403"));
    assert.ok(formatted.includes("blocked by gateway WAF"));
    assert.notEqual(formatted, "403 status code (no body)");
  });

  void test("applies a provider prefix with status and body", () => {
    const norm = normalizeProviderError(
      Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { error: "blocked by gateway WAF" },
      }),
    );

    assert.equal(
      formatProviderError(norm, "OpenAI API error"),
      'OpenAI API error (403): {"error":"blocked by gateway WAF"}',
    );
  });

  void test("preserves the message (with prefix + status) when it already carries the body", () => {
    const body = JSON.stringify({ error: { message: "Permission denied" } });
    const norm = normalizeProviderError(Object.assign(new Error(body), { status: 403 }));

    assert.equal(formatProviderError(norm, "OpenAI API error"), `OpenAI API error (403): ${body}`);
  });

  void test("returns the bare message for a non-Error value", () => {
    const norm = normalizeProviderError({ reason: "boom" });

    assert.equal(formatProviderError(norm), '{"reason":"boom"}');
  });
});
