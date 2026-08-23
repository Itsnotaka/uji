import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { THEME } from "../src/theme.ts";
import { requestWorkspaceTrust } from "../src/workspace-trust.ts";

void describe("workspace trust dialog", () => {
  let setup: TestRendererSetup;

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("shows the workspace gate with decline selected, so Enter declines", async () => {
    const result = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/Users/workgyver/Developer/uji/packages/tui",
      declineAction: "cancel",
    });
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    assert.match(frame, /Workspace Trust Required/);
    assert.match(frame, /Uji can execute code and access files in this directory\./);
    assert.match(frame, /Do you trust the contents of this directory\?/);
    assert.match(frame, /\/Users\/workgyver\/Developer\/uji\/packages\/tui/);
    assert.match(frame, /\[a\] Trust this workspace/);
    assert.match(frame, /▸ \[q\] Cancel/);
    assert.doesNotMatch(frame, /Allow once|Always allow|permission|search:/iu);

    setup.mockInput.pressEnter();
    assert.equal(await result, "decline");
  });

  void test("only trusts after selecting the trust choice", async () => {
    const byShortcut = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/repo",
      declineAction: "cancel",
    });
    await setup.mockInput.typeText("a");
    assert.equal(await byShortcut, "trust");

    const byArrow = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/repo",
      declineAction: "cancel",
    });
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    assert.equal(await byArrow, "trust");
  });

  void test("uses the shown shortcut for the declining choice", async () => {
    const byShortcut = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/repo",
      declineAction: "quit",
    });
    await setup.mockInput.typeText("q");
    assert.equal(await byShortcut, "decline");
  });

  void test("wraps its content instead of clipping on a narrow terminal", async () => {
    setup.resize(40, 30);
    const result = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/a/very/long/workspace/path/that/exceeds/the/window",
      declineAction: "cancel",
    });

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /Workspace Trust/);
    assert.match(frame, /▸ \[q\] Cancel/);
    assert.match(frame, /Uji can execute code and/);
    assert.match(frame, /access files in this/);
    assert.match(frame, /directory\./);
    assert.match(frame, /very\/long\/workspace/);
    setup.mockInput.pressEnter();
    assert.equal(await result, "decline");
  });

  void test("keeps both decisions separate when terminal height is constrained", async () => {
    setup.resize(50, 12);
    const result = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/repo",
      declineAction: "cancel",
    });

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const trustRow = lines.findIndex((line) => line.includes("Trust this workspace"));
    const declineRow = lines.findIndex((line) => line.includes("[q] Cancel"));
    assert.ok(trustRow >= 0, frame);
    assert.equal(declineRow, trustRow + 1, frame);
    assert.doesNotMatch(frame, /Cancelthis workspace/);

    setup.mockInput.pressEnter();
    assert.equal(await result, "decline");
  });

  void test("leaves the startup overlay to renderer teardown without queuing another frame", async () => {
    const result = requestWorkspaceTrust({
      renderer: setup.renderer,
      theme: THEME,
      cwd: "/repo",
      declineAction: "quit",
      nextId: (prefix = "trust") => prefix,
    });
    await setup.renderOnce();
    const requestRender = setup.renderer.requestRender.bind(setup.renderer);
    let renderRequests = 0;
    setup.renderer.requestRender = () => {
      renderRequests++;
      requestRender();
    };

    try {
      await setup.mockInput.typeText("q");
      assert.equal(await result, "decline");
      assert.equal(renderRequests, 0);
      assert.ok(setup.renderer.root.findDescendantById("trust-overlay") !== undefined);
    } finally {
      setup.renderer.requestRender = requestRender;
    }
  });
});
