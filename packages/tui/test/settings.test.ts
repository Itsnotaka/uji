import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createCliModels } from "../src/catalog.ts";
import { FileSettingsStore } from "../src/settings.ts";
import { preferredRunProvider, resolveRunModelId, runProviderCandidates } from "../src/run.ts";

void describe("settings", () => {
  void test("merges project settings over global settings by field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-settings-"));
    const globalPath = join(directory, "home", "settings.json");
    const project = join(directory, "project");
    try {
      await new FileSettingsStore(globalPath).updateGlobal({
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-8",
        defaultThinkingLevel: "high",
        transport: "sse",
        compaction: { enabled: true, reserveTokens: 12_000 },
      });
      await mkdir(join(project, ".uji"), { recursive: true });
      await writeFile(
        join(project, ".uji", "settings.json"),
        '{"transport":"websocket","compaction":{"enabled":false,"keepRecentTokens":9000}}\n',
      );

      assert.deepEqual(await new FileSettingsStore(globalPath).read(project), {
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-8",
        defaultThinkingLevel: "high",
        transport: "websocket",
        compaction: { enabled: false, reserveTokens: 12_000, keepRecentTokens: 9_000 },
        autoUpdate: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("preserves unrelated values across serialized global updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-settings-"));
    const globalPath = join(directory, "settings.json");
    try {
      const store = new FileSettingsStore(globalPath);
      await Promise.all([
        store.updateGlobal({ externalEditor: "nvim", compaction: { enabled: false } }),
        store.updateGlobal({ defaultProvider: "openai", defaultModel: "gpt-5.6-luna" }),
      ]);
      assert.equal(
        await readFile(globalPath, "utf8"),
        '{\n  "externalEditor": "nvim",\n  "compaction": {\n    "enabled": false\n  },\n  "defaultProvider": "openai",\n  "defaultModel": "gpt-5.6-luna"\n}\n',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("rejects invalid external settings at the boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-settings-"));
    const globalPath = join(directory, "settings.json");
    try {
      await writeFile(globalPath, '{"transport":"carrier-pigeon"}\n');
      await assert.rejects(new FileSettingsStore(globalPath).read(directory), /transport must be/);
      await writeFile(globalPath, '{"wat":true}\n');
      await assert.rejects(
        new FileSettingsStore(globalPath).read(directory),
        /unknown property "wat"/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("drops a fast mode key written by an older build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-settings-"));
    const globalPath = join(directory, "settings.json");
    try {
      await writeFile(globalPath, '{"fastMode":true,"transport":"sse"}\n');
      const store = new FileSettingsStore(globalPath);
      assert.equal("fastMode" in (await store.read(directory)), false);
      await store.updateGlobal({ externalEditor: "nvim" });
      assert.equal(
        await readFile(globalPath, "utf8"),
        '{\n  "transport": "sse",\n  "externalEditor": "nvim"\n}\n',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("tries the configured provider first without treating it as an override", () => {
    const models = createCliModels();
    const settings = {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
      transport: "auto" as const,
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      autoUpdate: false,
    };

    const catalogOrder = models.getProviders().map((provider) => provider.id);
    assert.deepEqual(
      runProviderCandidates(models, undefined, settings).map((provider) => provider.id),
      ["anthropic", ...catalogOrder.filter((id) => id !== "anthropic")],
    );
    assert.deepEqual(
      runProviderCandidates(models, "openai", settings).map((provider) => provider.id),
      ["openai"],
    );
    assert.equal(preferredRunProvider(models, undefined, settings).id, "anthropic");
  });

  void test("resolves flag, environment, project/global setting, then catalog model", () => {
    const models = createCliModels();
    const settings = {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
      transport: "auto" as const,
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      autoUpdate: false,
    };

    assert.equal(
      resolveRunModelId(models, "anthropic", {
        flag: "flag-model",
        environment: "environment-model",
        settings,
      }),
      "flag-model",
    );
    assert.equal(
      resolveRunModelId(models, "anthropic", {
        flag: undefined,
        environment: "environment-model",
        settings,
      }),
      "environment-model",
    );
    assert.equal(
      resolveRunModelId(models, "anthropic", {
        flag: undefined,
        environment: undefined,
        settings,
      }),
      "claude-opus-4-8",
    );
    assert.equal(
      resolveRunModelId(models, "openai-codex", {
        flag: undefined,
        environment: undefined,
        settings,
      }),
      undefined,
    );
  });
});
