import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { WorkspaceTrustRequired, WorkspaceTrustStore } from "../src/workspace-trust.ts";

async function fixture(): Promise<{ root: string; store: WorkspaceTrustStore }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uji-trust-")));
  return { root, store: new WorkspaceTrustStore(join(root, "state", "trust.json")) };
}

void describe("WorkspaceTrustStore", () => {
  void test("fails closed until the workspace is trusted", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    assert.deepEqual(await store.resolve(workspace), { kind: "unknown", cwd: workspace });
    await assert.rejects(store.require(workspace), WorkspaceTrustRequired);

    const trusted = await store.trust(workspace);
    assert.equal(trusted.cwd, workspace);
    assert.deepEqual(await store.resolve(workspace), {
      kind: "trusted",
      workspace: trusted,
      inheritedFrom: workspace,
    });
    assert.equal(
      await readFile(store.path, "utf8"),
      `${JSON.stringify({ [workspace]: true }, null, 2)}\n`,
    );
  });

  void test("inherits the closest trusted parent", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    const child = join(workspace, "packages", "core");
    await mkdir(child, { recursive: true });
    await store.trust(workspace);

    const resolution = await store.resolve(child);
    assert.equal(resolution.kind, "trusted");
    if (resolution.kind === "trusted") {
      assert.equal(resolution.workspace.cwd, child);
      assert.equal(resolution.inheritedFrom, workspace);
    }
  });

  void test("uses one identity for symlinked workspaces", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, "dir");

    await store.trust(alias);
    assert.equal((await store.require(workspace)).cwd, workspace);
  });

  void test("forgets only the exact decision", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await store.trust(workspace);
    await store.forget(workspace);

    assert.equal((await store.resolve(workspace)).kind, "unknown");
  });

  void test("rejects malformed external state", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(join(root, "state"));
    await writeFile(store.path, JSON.stringify({ relative: true }));

    await assert.rejects(store.resolve(workspace), /absolute paths to true/);
  });

  void test("serializes concurrent decisions without losing one", async () => {
    const { root, store } = await fixture();
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    await mkdir(alpha);
    await mkdir(beta);

    await Promise.all([store.trust(beta), store.trust(alpha)]);
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), {
      [alpha]: true,
      [beta]: true,
    });
  });
});
