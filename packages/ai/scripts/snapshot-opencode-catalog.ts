/**
 * Snapshot the OpenCode catalog for offline boot.
 *
 * Writes src/providers/snapshots/opencode-catalog.json: the two provider subtrees
 * of https://models.opencode.ai/api.json, verbatim. The providers parse the
 * snapshot with the same parseOpenCodeCatalog that parses the live response,
 * so baked and fetched models can never disagree on mapping; this script runs
 * that parser so a schema change fails here instead of at boot.
 *
 * Run: pnpm models:opencode:snapshot from the repository root.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
  OpenCodeCatalogSchema,
  parseOpenCodeCatalog,
  type OpenCodeProviderId,
} from "../src/providers/opencode-catalog.ts";

const CATALOG_URL = "https://models.opencode.ai/api.json";

const response = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
if (!response.ok) {
  throw new Error(`OpenCode catalog request failed with HTTP ${String(response.status)}`);
}
const catalog: unknown = await response.json();
if (!Value.Check(OpenCodeCatalogSchema, catalog)) {
  throw new Error("OpenCode catalog is not an object");
}
const snapshot = { opencode: catalog.opencode, "opencode-go": catalog["opencode-go"] };
for (const providerId of ["opencode", "opencode-go"] satisfies OpenCodeProviderId[]) {
  const models = parseOpenCodeCatalog(snapshot, providerId);
  console.log(`${providerId}: ${String(models.length)} tool-capable models`);
}
const path = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "providers",
  "snapshots",
  "opencode-catalog.json",
);
writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
