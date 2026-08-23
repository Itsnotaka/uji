import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTuiRenderLog } from "../src/render-log.ts";

interface RenderLogDetail {
  kind: string;
  sequence: number;
}

function parseRenderLogDetail(line: string): RenderLogDetail {
  const event: unknown = JSON.parse(line);
  assert.ok(
    typeof event === "object" &&
      event !== null &&
      "kind" in event &&
      typeof event.kind === "string" &&
      "sequence" in event &&
      typeof event.sequence === "number",
  );
  return { kind: event.kind, sequence: event.sequence };
}

void describe("TUI render log", () => {
  let setup: TestRendererSetup | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    setup?.renderer.destroy();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  void test("records frames, renderer state, and teardown as JSONL", async () => {
    directory = await mkdtemp(join(tmpdir(), "uji-tui-log-"));
    const path = join(directory, "render.jsonl");
    const log = createTuiRenderLog(path);
    assert.ok(log !== undefined);
    setup = await createTestRenderer({ width: 80, height: 24 });

    log.attach(setup.renderer);
    log.record({ kind: "run_started" });
    await setup.renderOnce();
    setup.renderer.destroy();
    log.record({ kind: "renderer_destroyed", activeResources: [] });
    log.close();
    log.close();

    const contents = readFileSync(path, "utf8");
    const details = contents.trimEnd().split("\n").map(parseRenderLogDetail);
    const kinds = details.map((event) => event.kind);
    assert.ok(kinds.indexOf("render_log_opened") < kinds.indexOf("frame"));
    assert.ok(kinds.indexOf("frame") < kinds.indexOf("renderer_destroy_started"));
    assert.ok(kinds.indexOf("renderer_destroy_started") < kinds.indexOf("renderer_destroyed"));
    assert.equal(kinds.at(-1), "render_log_closed");
    assert.equal(kinds.filter((kind) => kind === "render_log_closed").length, 1);
    assert.deepEqual(
      details.map((event) => event.sequence),
      details.map((_, index) => index),
    );
    assert.match(contents, /"scheduler":\{"isRunning":false,"isRendering":false/u);
    assert.doesNotMatch(contents, /"kind":"renderer_destroyed"[^\n]+"scheduler"/u);
  });

  void test("stays disabled without an explicit target", () => {
    assert.equal(createTuiRenderLog(undefined), undefined);
    assert.equal(createTuiRenderLog("false"), undefined);
  });
});
