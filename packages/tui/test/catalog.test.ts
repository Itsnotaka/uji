import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { FetchFunction } from "@uji-ai/ai";
import {
  createCliModels,
  defaultModel,
  loadAuthenticatedModels,
  providerAuthStatuses,
} from "../src/catalog.ts";

function catalogModel(
  id: string,
  name: string,
  npm: "@ai-sdk/anthropic" | "@ai-sdk/google" | "@ai-sdk/openai" | "@ai-sdk/openai-compatible",
): object {
  return {
    id,
    name,
    tool_call: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 131_072 },
    cost: { input: 0, output: 0, cache_read: 0 },
    provider: { npm },
  };
}

function openCodeCatalog(includeNewModels: boolean): object {
  return {
    opencode: {
      id: "opencode",
      name: "OpenCode Zen",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "x-preview-f-free": catalogModel(
          "x-preview-f-free",
          "Ox Alpha Free (Unlimited)",
          "@ai-sdk/openai-compatible",
        ),
        ...(includeNewModels
          ? {
              "catalog-added-claude": catalogModel(
                "catalog-added-claude",
                "Catalog Added Claude",
                "@ai-sdk/anthropic",
              ),
            }
          : {}),
      },
    },
    "opencode-go": {
      id: "opencode-go",
      name: "OpenCode Go",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "ox-alpha-free": catalogModel(
          "ox-alpha-free",
          "Ox Alpha Free (Unlimited)",
          "@ai-sdk/openai-compatible",
        ),
        ...(includeNewModels
          ? {
              "catalog-added-gpt": catalogModel(
                "catalog-added-gpt",
                "Catalog Added GPT",
                "@ai-sdk/openai",
              ),
              "unsupported-go-google": catalogModel(
                "unsupported-go-google",
                "Unsupported Go Google",
                "@ai-sdk/google",
              ),
            }
          : {}),
      },
    },
  };
}

void describe("CLI provider catalog", () => {
  void test("exposes catalogs for logged-in API-key providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-catalog-"));
    const previousHome = process.env["UJI_HOME"];
    process.env["UJI_HOME"] = directory;
    try {
      let includeNewModels = false;
      const requestedUrls: string[] = [];
      const catalogFetch: FetchFunction = async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify(openCodeCatalog(includeNewModels)), {
          headers: { "content-type": "application/json" },
        });
      };
      const models = createCliModels({ fetch: catalogFetch });
      const providers = models
        .getProviders()
        .filter((provider) => provider.auth.apiKey?.login !== undefined);

      assert.ok(providers.length > 0);
      for (const provider of providers) {
        await models.login(provider.id, "api_key", {
          signal: new AbortController().signal,
          prompt: async () => "test-key",
          notify() {},
        });
      }

      const initialRefresh = await models.refresh({ force: true });
      assert.deepEqual([...initialRefresh.errors], []);
      assert.equal(models.getModel("opencode", "catalog-added-claude"), undefined);
      assert.equal(models.getModel("opencode-go", "catalog-added-gpt"), undefined);

      includeNewModels = true;
      const updatedRefresh = await models.refresh({ force: true });
      assert.deepEqual([...updatedRefresh.errors], []);
      assert.equal(models.getModel("opencode", "catalog-added-claude")?.api, "anthropic-messages");
      assert.equal(models.getModel("opencode-go", "catalog-added-gpt")?.api, "openai-responses");
      assert.equal(models.getModel("opencode-go", "unsupported-go-google"), undefined);
      assert.deepEqual(new Set(requestedUrls), new Set(["https://models.opencode.ai/api.json"]));

      for (const provider of providers) {
        const available = await models.getAvailable(provider.id);

        assert.deepEqual(available, models.getModels(provider.id), provider.id);
        assert.ok(available.length > 0, provider.id);
        assert.ok(
          available.every((model) => model.provider === provider.id),
          provider.id,
        );
        assert.equal(defaultModel(models, provider.id).provider, provider.id);
      }

      const authenticated = (await providerAuthStatuses(models)).flatMap((status) =>
        status.kind === "authenticated" ? [status.provider.id] : [],
      );
      for (const provider of providers) assert.ok(authenticated.includes(provider.id));

      const combined = await loadAuthenticatedModels(models);
      for (const provider of providers) {
        assert.ok(
          combined.some((model) => model.provider === provider.id),
          `missing ${provider.id} models from the combined catalog`,
        );
      }

      const anthropic = await models.getAvailable("anthropic");
      assert.equal(defaultModel(models, "anthropic").id, "claude-opus-5");
      assert.ok(anthropic.some((model) => model.id === "claude-opus-5"));
      assert.ok(anthropic.some((model) => model.id === "claude-fable-5"));

      const zenDefault = defaultModel(models, "opencode");
      assert.deepEqual(
        { id: zenDefault.id, name: zenDefault.name },
        { id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)" },
      );

      const goDefault = defaultModel(models, "opencode-go");
      assert.deepEqual(
        { id: goDefault.id, name: goDefault.name },
        { id: "ox-alpha-free", name: "Ox Alpha Free (Unlimited)" },
      );
    } finally {
      if (previousHome === undefined) delete process.env["UJI_HOME"];
      else process.env["UJI_HOME"] = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
