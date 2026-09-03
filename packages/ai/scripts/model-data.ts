import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { KnownProvider } from "../src/types.ts";

export const MODEL_DATA_SCHEMA_VERSION = 3;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

/** Static provider catalogs Uji checks in and exposes through explicit factories. */
export const GENERATED_MODEL_PROVIDER_IDS: readonly KnownProvider[] = [
  "anthropic",
  "openai",
  "openai-codex",
];

export type ModelDataStructure = Record<string, Record<string, string>>;

const ModelDataManifestSchema = Type.Object({
  schemaVersion: Type.Number(),
  generatedAt: Type.String(),
  structureHash: Type.String(),
  files: Type.Record(Type.String(), Type.String()),
});

export type ModelDataManifest = Static<typeof ModelDataManifestSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeSetDifference(expected: readonly string[], actual: readonly string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  return [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    extra.length > 0 ? `extra: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function assertExactModelIds(
  label: string,
  expected: Iterable<string>,
  actual: Iterable<string>,
): void {
  const expectedIds = Array.from(new Set(expected)).sort();
  const actualIds = Array.from(new Set(actual)).sort();
  if (sameStrings(expectedIds, actualIds)) return;
  throw new Error(
    `${label} model IDs do not match (${describeSetDifference(expectedIds, actualIds)})`,
  );
}

/**
 * API group -> model id -> model. Both key levels are genuinely open; the model
 * value is a decoder handoff to validateModelValue.
 */
const ModelDataFileSchema = Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()));

function readJsonFile<Schema extends TSchema>(
  path: string,
  description: string,
  schema: Schema,
  errors: string[],
): Static<Schema> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(
      `${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!Value.Check(schema, parsed)) {
    errors.push(`${description} must contain a JSON object`);
    return undefined;
  }
  return parsed;
}

function readProviderStructure(path: string, providerId: string): Record<string, string> {
  const errors: string[] = [];
  const groups = readJsonFile(path, `${providerId}.json`, ModelDataFileSchema, errors);
  if (!groups) throw new Error(errors.join("\n"));

  const models = new Map<string, string>();
  for (const [api, value] of Object.entries(groups)) {
    for (const modelId of Object.keys(value)) {
      if (models.has(modelId))
        throw new Error(`${path} contains model ${modelId} in more than one API group`);
      models.set(modelId, api);
    }
  }
  if (models.size === 0) throw new Error(`${path} contains no generated model data`);
  return sortedRecord(models);
}

export function readModelDataStructure(
  packageRoot: string,
  providerIds: readonly string[],
): ModelDataStructure {
  const providersDir = join(packageRoot, "src", "providers");
  const dataDir = join(providersDir, "data");
  const expectedShards = providerIds.map((providerId) => `${providerId}.models.ts`).sort();
  const actualShards = readdirSync(providersDir)
    .filter((entry) => entry.endsWith(".models.ts"))
    .sort();
  if (!sameStrings(expectedShards, actualShards)) {
    throw new Error(
      `Configured model providers and generated shards do not match (${describeSetDifference(expectedShards, actualShards)})`,
    );
  }

  return sortedRecord(
    providerIds.map((providerId) => [
      providerId,
      readProviderStructure(join(dataDir, `${providerId}.json`), providerId),
    ]),
  );
}

export function modelDataStructureHash(structure: ModelDataStructure): string {
  const normalized = sortedRecord(
    Object.entries(structure).map(
      ([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
    ),
  );
  return sha256(JSON.stringify(normalized));
}

export function createModelDataManifest(
  structure: ModelDataStructure,
  fileContents: Readonly<Record<string, string>>,
  generatedAt: string,
): ModelDataManifest {
  return {
    schemaVersion: MODEL_DATA_SCHEMA_VERSION,
    generatedAt,
    structureHash: modelDataStructureHash(structure),
    files: sortedRecord(
      Object.entries(fileContents).map(([file, content]) => [file, sha256(content)] as const),
    ),
  };
}

const ModelCostSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
});

const ModelValueSchema = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  api: Type.String(),
  name: Type.String({ minLength: 1 }),
  baseUrl: Type.String(),
  reasoning: Type.Boolean(),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1 }),
  contextWindow: Type.Number({ exclusiveMinimum: 0 }),
  maxTokens: Type.Number({ exclusiveMinimum: 0 }),
  cost: ModelCostSchema,
});

function validateModelValue(
  value: unknown,
  providerId: string,
  modelId: string,
  expectedApi: string,
  errors: string[],
): void {
  const label = `${providerId}/${modelId}`;
  if (!Value.Check(ModelValueSchema, value)) {
    const fields = new Set<string>();
    for (const error of Value.Errors(ModelValueSchema, value)) {
      const path = error.instancePath.slice(1).replaceAll("/", ".");
      if (error.keyword === "required") {
        for (const property of error.params.requiredProperties) {
          fields.add(path === "" ? property : `${path}.${property}`);
        }
      } else if (path !== "") fields.add(path);
    }
    const detail = Array.from(fields).join(", ");
    errors.push(detail === "" ? `${label} must be an object` : `${label} has invalid ${detail}`);
    return;
  }
  if (value.id !== modelId)
    errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
  if (value.provider !== providerId) {
    errors.push(
      `${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`,
    );
  }
  if (value.api !== expectedApi) {
    errors.push(
      `${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`,
    );
  }
}

function throwValidationErrors(errors: string[]): never {
  const visible = errors.slice(0, 30);
  const suffix =
    errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
  throw new Error(
    `Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`,
  );
}

export function validateModelDataDirectory(structure: ModelDataStructure, dataDir: string): void {
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    throw new Error(`Generated model data directory does not exist: ${dataDir}`);
  }

  const errors: string[] = [];
  const expectedFiles = Object.keys(structure)
    .map((providerId) => `${providerId}.json`)
    .sort();
  const actualFiles = readdirSync(dataDir)
    .filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
    .sort();
  if (!sameStrings(expectedFiles, actualFiles)) {
    errors.push(
      `provider data files do not match the generated catalog (${describeSetDifference(expectedFiles, actualFiles)})`,
    );
  }

  const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
  const manifest = readJsonFile(
    manifestPath,
    "model data manifest",
    ModelDataManifestSchema,
    errors,
  );
  if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) {
    errors.push(
      `model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
    );
  }
  if (typeof manifest?.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) {
    errors.push("model data manifest has an invalid generation timestamp");
  }
  const expectedStructureHash = modelDataStructureHash(structure);
  if (manifest?.structureHash !== expectedStructureHash) {
    errors.push("model data generation stamp does not match the generated catalog");
  }
  const manifestFiles = manifest?.files;
  if (!manifestFiles) errors.push("model data manifest has no file hashes");
  else {
    const manifestFileNames = Object.keys(manifestFiles).sort();
    if (!sameStrings(expectedFiles, manifestFileNames)) {
      errors.push(
        `manifest file hashes do not match provider data files (${describeSetDifference(expectedFiles, manifestFileNames)})`,
      );
    }
  }

  for (const [providerId, expectedModels] of Object.entries(structure)) {
    const filename = `${providerId}.json`;
    const path = join(dataDir, filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (manifestFiles && manifestFiles[filename] !== sha256(content)) {
      errors.push(`${filename} does not match its manifest hash`);
    }
    const groups = readJsonFile(path, filename, ModelDataFileSchema, errors);
    if (!groups) continue;

    const actualModels = new Map<string, string>();
    for (const [api, value] of Object.entries(groups)) {
      for (const [modelId, model] of Object.entries(value)) {
        if (actualModels.has(modelId)) {
          errors.push(`${providerId}/${modelId} appears in more than one API group`);
          continue;
        }
        actualModels.set(modelId, api);
        validateModelValue(model, providerId, modelId, api, errors);
      }
    }

    const expectedModelIds = Object.keys(expectedModels).sort();
    const actualModelIds = Array.from(actualModels.keys()).sort();
    if (!sameStrings(expectedModelIds, actualModelIds)) {
      errors.push(
        `${filename} model IDs do not match the generated catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`,
      );
    }
    for (const [modelId, expectedApi] of Object.entries(expectedModels)) {
      const actualApi = actualModels.get(modelId);
      if (actualApi !== undefined && actualApi !== expectedApi) {
        errors.push(
          `${providerId}/${modelId} is grouped under API ${JSON.stringify(actualApi)}, expected ${JSON.stringify(expectedApi)}`,
        );
      }
    }
  }

  if (errors.length > 0) throwValidationErrors(errors);
}

export function validateGeneratedModelData(packageRoot: string): void {
  const structure = readModelDataStructure(packageRoot, GENERATED_MODEL_PROVIDER_IDS);
  validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}
