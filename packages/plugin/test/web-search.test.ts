import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Model } from "@uji-ai/schema";
import { inlinePlugin } from "@uji-ai/plugin";
import {
  createWebSearchTool,
  webSearchPlugin,
  type WebSearchCredentials,
  type WebSearchProviderId,
} from "../examples/web-search.ts";
import { runCommand, settingOf, TestWorkspace } from "./host.ts";

function fetchMock(
  calls: Request[],
  respond: (request: Request) => Response,
): typeof globalThis.fetch {
  return (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return Promise.resolve(respond(request));
  };
}

function mcp(result: Readonly<Record<string, unknown>>): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result });
}

function mcpSse(result: Readonly<Record<string, unknown>>): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`,
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function bodyOf(request: Request): Promise<unknown> {
  return request.json();
}

function fixed(provider: WebSearchProviderId) {
  return () => Promise.resolve(provider);
}

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

void describe("web search tool", () => {
  void test("sends an optional Exa key and formats its MCP results", async () => {
    const calls: Request[] = [];
    const credentials: WebSearchCredentials = {
      read: () => Promise.resolve("exa-secret"),
      write: () => Promise.resolve(),
    };
    const tool = createWebSearchTool(fixed("exa"), {
      credentials,
      environment: () => undefined,
      fetch: fetchMock(calls, () =>
        mcpSse({
          content: [
            {
              type: "text",
              text: "Title: Effect 4\nURL: https://example.com/effect\nPublished: 2026-01-02\nHighlights:\nCurrent release notes",
            },
          ],
        }),
      ),
    });

    const response = await tool.execute("call-1", { query: " Effect 4 " });

    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.ok(request);
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, "https://mcp.exa.ai/mcp");
    assert.equal(url.searchParams.get("exaApiKey"), "exa-secret");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("Accept"), "application/json, text/event-stream");
    assert.equal(request.headers.get("Content-Type"), "application/json");
    assert.equal(request.headers.get("MCP-Protocol-Version"), null);
    assert.deepEqual(await bodyOf(request), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: "Effect 4", numResults: 8 },
      },
    });
    assert.deepEqual(response.details, {
      provider: "exa",
      results: [
        {
          url: "https://example.com/effect",
          title: "Effect 4",
          content: "Current release notes",
          published: Date.parse("2026-01-02"),
        },
      ],
    });
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /Effect 4/);
  });

  void test("uses Parallel bearer auth and structured results", async () => {
    const calls: Request[] = [];
    const tool = createWebSearchTool(fixed("parallel"), {
      environment: (name) => (name === "PARALLEL_API_KEY" ? "parallel-secret" : undefined),
      fetch: fetchMock(calls, () =>
        mcp({
          content: [{ type: "text", text: "ok" }],
          structuredContent: {
            results: [
              {
                url: "https://example.com/parallel",
                title: "Parallel result",
                publish_date: "2026-03-01",
                excerpts: ["first", "second"],
              },
            ],
          },
        }),
      ),
    });

    const response = await tool.execute("call-2", { query: "current releases" });

    const request = calls[0];
    assert.ok(request);
    assert.equal(request.headers.get("Authorization"), "Bearer parallel-secret");
    assert.deepEqual(await bodyOf(request), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          objective: "current releases",
          search_queries: ["current releases"],
        },
      },
    });
    assert.deepEqual(response.details, {
      provider: "parallel",
      results: [
        {
          url: "https://example.com/parallel",
          title: "Parallel result",
          content: "first\n\nsecond",
          published: Date.parse("2026-03-01"),
        },
      ],
    });
  });

  void test("uses Firecrawl bearer auth and decodes its text payload", async () => {
    const calls: Request[] = [];
    const tool = createWebSearchTool(fixed("firecrawl"), {
      environment: (name) => (name === "FIRECRAWL_API_KEY" ? "fire-secret" : undefined),
      fetch: fetchMock(calls, () =>
        mcpSse({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                data: {
                  web: [
                    {
                      url: "https://example.com/fire",
                      title: "Firecrawl result",
                      description: "Fresh page",
                    },
                  ],
                },
              }),
            },
          ],
        }),
      ),
    });

    const response = await tool.execute("call-3", { query: "fresh page" });

    const request = calls[0];
    assert.ok(request);
    assert.equal(request.headers.get("Authorization"), "Bearer fire-secret");
    assert.deepEqual(await bodyOf(request), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "firecrawl_search",
        arguments: { query: "fresh page", limit: 8 },
      },
    });
    assert.deepEqual(response.details, {
      provider: "firecrawl",
      results: [
        {
          url: "https://example.com/fire",
          title: "Firecrawl result",
          content: "Fresh page",
        },
      ],
    });
  });

  void test("shuffles and falls back only in automatic mode", async () => {
    const calls: Request[] = [];
    const ranks = [0.9, 0.1, 0.5];
    const tool = createWebSearchTool(() => Promise.resolve("auto"), {
      random: () => ranks.shift() ?? 0,
      environment: () => undefined,
      fetch: fetchMock(calls, (request) => {
        if (new URL(request.url).hostname !== "mcp.exa.ai") {
          return new Response("unavailable", { status: 503 });
        }
        return mcp({
          content: [{ type: "text", text: "Title: Last\nURL: https://example.com/last" }],
        });
      }),
    });

    const response = await tool.execute("call-4", { query: "fallback" });

    assert.deepEqual(
      calls.map((request) => new URL(request.url).hostname),
      ["search.parallel.ai", "mcp.firecrawl.dev", "mcp.exa.ai"],
    );
    assert.equal(response.details.provider, "exa");

    const explicitCalls: Request[] = [];
    const explicit = createWebSearchTool(fixed("parallel"), {
      environment: () => undefined,
      fetch: fetchMock(explicitCalls, () => new Response("unavailable", { status: 503 })),
    });
    await assert.rejects(
      explicit.execute("call-5", { query: "strict" }),
      /Parallel web search request failed:.*unavailable/,
    );
    assert.equal(explicitCalls.length, 1);
  });

  void test("saves optional keys outside session storage and exposes provider policy", async () => {
    const world = TestWorkspace.create("uji-web-search-");
    const keys = new Map<WebSearchProviderId, string>();
    const credentials: WebSearchCredentials = {
      read: (provider) => Promise.resolve(keys.get(provider)),
      write: (provider, key) => {
        if (key === undefined) keys.delete(provider);
        else keys.set(provider, key);
        return Promise.resolve();
      },
    };
    const sdk = await world.open({
      streamFn() {
        throw new Error("stream should not run while configuring web search");
      },
      plugins: [inlinePlugin(webSearchPlugin({ credentials }))],
      model,
    });
    const { sessionId } = world;
    try {
      assert.equal(await settingOf(sdk, sessionId, "websearch-provider"), "auto");
      assert.deepEqual(
        await sdk.plugins.settings.apply({
          sessionId,
          id: "websearch-provider",
          choiceId: "parallel",
        }),
        { kind: "applied" },
      );
      assert.equal(await settingOf(sdk, sessionId, "websearch-provider"), "parallel");
      // The key rides the argument; a secret must never become a durable reply.
      assert.equal(
        await runCommand(sdk, sessionId, "websearch-key", "exa saved-secret"),
        "Saved Exa API key.",
      );
      assert.equal(keys.get("exa"), "saved-secret");
      assert.equal(
        await runCommand(sdk, sessionId, "websearch-key", "exa"),
        "Removed Exa API key.",
      );
      assert.equal(keys.has("exa"), false);
    } finally {
      await world.close();
    }
  });

  void test("treats an empty automatic result as a successful search", async () => {
    const calls: Request[] = [];
    const ranks = [0.9, 0.1, 0.5];
    const tool = createWebSearchTool(() => Promise.resolve("auto"), {
      random: () => ranks.shift() ?? 0,
      environment: () => undefined,
      fetch: fetchMock(calls, () => mcp({ content: [], structuredContent: { results: [] } })),
    });

    const response = await tool.execute("call-6", { query: "nothing" });

    assert.equal(calls.length, 1);
    assert.equal(response.details.provider, "parallel");
    assert.equal(
      response.content[0]?.type === "text" ? response.content[0].text : "",
      "No search results found. Please try a different query.",
    );
  });
});
