import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const docsRoot = join(repositoryRoot, "packages/docs/content/docs");
const failures = [];

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") || entry.name.endsWith(".mdx") ? [path] : [];
  });
}

function roadmapHas(id, status) {
  return new RegExp(`\\|\\s+\\\`${id}\\\`\\s+\\|\\s+${status}\\s+\\|`).test(roadmap);
}

const roadmap = read("packages/docs/content/docs/roadmap.mdx");
const harness = read("packages/core/src/harness/agent-harness.ts");
const sessionTypes = read("packages/core/src/harness/session/types.ts");
const sqlite = read("packages/core/src/harness/session/sqlite.ts");
const schema = read("packages/schema/src/index.ts");
const messageSchema = read("packages/schema/src/message.ts");
const shell = read("packages/core/src/tools/support/shell.ts");
const desktopHost = read("packages/demo/grok-bot/src/main/june-host.ts");
const productionDependencies = read("packages/demo/grok-bot/src/main/production-dependencies.ts");

expect(
  roadmap.includes("This is June's roadmap, not a parity checklist"),
  "Roadmap must state that June, not pi parity, defines the target.",
);
expect(
  roadmap.includes("Adopt the problem") && roadmap.includes("Reject as a parity goal"),
  "Roadmap must classify reference ideas instead of turning them into a parity backlog.",
);

const expectedStatuses = {
  "GAP-C01": "Partial",
  "GAP-C02": "Partial",
  "GAP-C03": "Partial",
  "GAP-C04": "Partial",
  "GAP-C05": "Partial",
  "GAP-C06": "Not started",
  "GAP-C07": "Partial",
  "GAP-C08": "Exists",
  "GAP-C09": "Partial",
  "GAP-C10": "Partial",
  "GAP-D01": "Partial",
  "GAP-D02": "Not started",
  "GAP-D03": "Partial",
  "GAP-D04": "Partial",
  "GAP-D05": "Partial",
  "GAP-D06": "Partial",
  "GAP-D07": "Not started",
  "GAP-D08": "Partial",
  "GAP-D09": "Not started",
  "GAP-D10": "Partial",
  "GAP-H01": "Not started",
  "GAP-H02": "Not started",
  "GAP-H03": "Not started",
  "GAP-H04": "Partial",
  "GAP-H05": "Partial",
  "GAP-H06": "Partial",
  "GAP-H07": "Partial",
  "GAP-H08": "Partial",
  "GAP-P01": "Not started",
  "GAP-P02": "Not started",
  "GAP-P03": "Not started",
  "GAP-P04": "Not started",
  "GAP-P05": "Not started",
  "GAP-P06": "Not started",
  "GAP-P07": "Partial",
  "GAP-P08": "Not started",
};

for (const [id, status] of Object.entries(expectedStatuses)) {
  expect(
    roadmapHas(id, status),
    `${id} must remain present with status ${status}, or this audit must be updated.`,
  );
}

const allDocs = markdownFiles(docsRoot)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
for (const [pattern, description] of [
  [/199 lines/i, "the old JuneHost line count"],
  [/seventeen markers/i, "the removed SDK-marker count"],
  [/five IPC methods/i, "the old desktop method count"],
  [/six functions/i, "the old preload method count"],
  [/TODO\(sdk/i, "removed TODO(sdk.*) markers"],
  [/close the distance between[^\n]*pi/i, "Pi-parity roadmap language"],
]) {
  expect(!pattern.test(allDocs), `Docs still contain ${description}.`);
}

const promptStart = harness.indexOf("prompt(input:");
const promptEnd = harness.indexOf("async steer(", promptStart);
const promptBody = harness.slice(promptStart, promptEnd);
expect(promptStart >= 0 && promptEnd > promptStart, "Could not locate AgentHarness.prompt().");
expect(
  promptBody.includes("this.pendingPrompt = pending"),
  "GAP-C01 source changed: re-audit prompt admission and update the roadmap.",
);
expect(
  harness.includes('const LANE = "main"'),
  "GAP-D01 source changed: the hard-coded lane is gone; re-audit lanes and update the roadmap.",
);
expect(
  /for \(const listener of this\.listeners\)[\s\S]{0,80}await listener\(event\)/.test(harness),
  "GAP-C05 source changed: re-audit listener isolation and update the roadmap.",
);
expect(
  !harness.includes("cancelQueued("),
  "GAP-D05 source changed: a queue-cancellation API exists; update the roadmap.",
);
expect(
  /return `\$\{prefix\}_\$\{randomUUID\(\)\.slice\(0, 8\)\}`/.test(sessionTypes),
  "GAP-C07 source changed: durable ID generation changed; re-audit and update the roadmap.",
);
expect(
  !/ResponseItem|ToolResultPart|ContentPart/.test(schema) &&
    messageSchema.includes("content: (TextContent | ImageContent)[];"),
  "GAP-C08 source changed: re-audit the canonical Message and tool-result part contract.",
);
expect(
  /private readonly active = new Set<SqliteSessionStorage>\(\)/.test(sqlite) &&
    sqlite.includes("this.active.delete("),
  "GAP-C09 source changed: re-audit repository storage tracking and update the roadmap.",
);
expect(
  sqlite.includes("INSERT INTO entries_fts(rowid, payload) VALUES (new.rowid, new.payload)"),
  "GAP-C10 source changed: re-audit the FTS projection and update the roadmap.",
);
expect(
  shell.includes("detached-child pid registry is not ported"),
  "GAP-C09 source changed: re-audit process cleanup and update the roadmap.",
);

const coreTestFiles = readdirSync(join(repositoryRoot, "packages/core/test"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => read(`packages/core/test/${name}`));
expect(
  !coreTestFiles.some((source) => /\bAgentHarness\b/.test(source)),
  "GAP-C06 source changed: an AgentHarness test now exists; re-audit coverage and update the roadmap.",
);

for (const packageName of ["protocol", "server", "client", "plugin"]) {
  expect(
    !existsSync(join(repositoryRoot, `packages/${packageName}`)),
    `packages/${packageName} now exists; update the roadmap and host-contract status.`,
  );
}

expect(
  productionDependencies.includes("createModels(") &&
    productionDependencies.includes("openaiCodexProvider()"),
  "Desktop provider composition changed; update host-sdk.mdx and GAP-H04.",
);
expect(
  desktopHost.includes("this.harness = created.harness") &&
    !desktopHost.includes("created.suspended"),
  "Desktop suspended-run handling changed; update host-sdk.mdx and GAP-H05.",
);
expect(
  desktopHost.includes("await this.sessions.close()") &&
    desktopHost.includes("this.profileRepo.close()"),
  "Desktop teardown changed; update host-sdk.mdx and GAP-H08.",
);

if (failures.length > 0) {
  console.error("Core roadmap audit failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Core roadmap audit passed (${Object.keys(expectedStatuses).length} tracked gaps; June-first framing and source facts verified).`,
  );
}
