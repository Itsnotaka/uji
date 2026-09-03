/**
 * Based on https://github.com/anomalyco/opencode/tree/4af6f98d824116f587f6e46bc220d7b830baeace/packages/core/src/plugin/websearch
 * and https://github.com/anomalyco/opencode/blob/4af6f98d824116f587f6e46bc220d7b830baeace/packages/core/src/websearch.ts
 */
import process from "node:process";
import { definePlugin } from "@uji-ai/plugin";
import type { HarnessTool } from "@uji-ai/plugin";
import type { JsonValue } from "@uji-ai/schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const WEB_SEARCH_PLUGIN_ID = "web-search";

const PROVIDER_KEY = "provider";
const WEB_SEARCH_PROVIDER_ENV = "UJI_WEBSEARCH_PROVIDER";
const REQUEST_TIMEOUT_MS = 25_000;
const NO_RESULTS = "No search results found. Please try a different query.";

interface WebSearchResult {
  readonly url: string;
  readonly title?: string;
  readonly content?: string;
  readonly published?: number;
}

interface ProviderDefinition {
  readonly name: string;
  readonly endpoint: string;
  readonly keyEnvironment: string;
  readonly tool: string;
  readonly arguments: (query: string) => Readonly<Record<string, JsonValue>>;
  readonly authorize: (url: URL, headers: Record<string, string>, key: string) => void;
  readonly results: (result: WebSearchMcpResult) => WebSearchResult[];
}

const webSearchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, description: "Web search query" }),
  },
  { additionalProperties: false },
);

const WebSearchMcpResultSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
});
type WebSearchMcpResult = Static<typeof WebSearchMcpResultSchema>;

const JsonRpcResultSchema = Type.Object({ result: WebSearchMcpResultSchema });
const McpTextContentSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parsePublished(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const published = Date.parse(value);
  return Number.isFinite(published) ? published : undefined;
}

function result(url: string, values: Omit<WebSearchResult, "url">): WebSearchResult {
  return {
    url,
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.content === undefined ? {} : { content: values.content }),
    ...(values.published === undefined ? {} : { published: values.published }),
  };
}

function textContent(value: WebSearchMcpResult): string | undefined {
  for (const item of value.content) {
    if (!Value.Check(McpTextContentSchema, item)) continue;
    const text = optionalString(item.text);
    if (text !== undefined) return text;
  }
  return undefined;
}

function exaResults(value: WebSearchMcpResult): WebSearchResult[] {
  const text = textContent(value);
  if (text === undefined) return [];
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
    if (url === undefined || url === "") return [];
    const rawTitle = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const title = rawTitle === "N/A" ? undefined : rawTitle;
    const published = parsePublished(block.match(/^Published:\s*(.+)$/m)?.[1]?.trim());
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim();
    return [result(url, { title, content: content || undefined, published })];
  });
}

const ParallelPayloadSchema = Type.Object({ results: Type.Array(Type.Unknown()) });
const ParallelItemSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.Unknown()),
  excerpts: Type.Optional(Type.Unknown()),
  publish_date: Type.Optional(Type.Unknown()),
});

function parallelResults(value: WebSearchMcpResult): WebSearchResult[] {
  const structured = value.structuredContent;
  if (!Value.Check(ParallelPayloadSchema, structured)) return [];
  return structured.results.flatMap((item) => {
    if (!Value.Check(ParallelItemSchema, item)) return [];
    const excerpts = Array.isArray(item.excerpts)
      ? item.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
      : [];
    return [
      result(item.url, {
        title: optionalString(item.title),
        content: excerpts.length === 0 ? undefined : excerpts.join("\n\n"),
        published: parsePublished(item.publish_date),
      }),
    ];
  });
}

const FirecrawlPayloadSchema = Type.Object({
  data: Type.Object({ web: Type.Array(Type.Unknown()) }),
});
const FirecrawlItemSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.Unknown()),
  description: Type.Optional(Type.Unknown()),
});

function firecrawlResults(value: WebSearchMcpResult): WebSearchResult[] {
  const text = textContent(value);
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Value.Check(FirecrawlPayloadSchema, parsed)) return [];
  return parsed.data.web.flatMap((item) => {
    if (!Value.Check(FirecrawlItemSchema, item)) return [];
    return [
      result(item.url, {
        title: optionalString(item.title),
        content: optionalString(item.description),
      }),
    ];
  });
}

export type WebSearchProviderId = "exa" | "parallel" | "firecrawl";
type WebSearchSelection = "auto" | WebSearchProviderId;

const PROVIDERS = {
  exa: {
    name: "Exa",
    endpoint: "https://mcp.exa.ai/mcp",
    keyEnvironment: "EXA_API_KEY",
    tool: "web_search_exa",
    arguments: (query) => ({ query, numResults: 8 }),
    authorize: (url, _headers, key) => url.searchParams.set("exaApiKey", key),
    results: exaResults,
  },
  parallel: {
    name: "Parallel",
    endpoint: "https://search.parallel.ai/mcp",
    keyEnvironment: "PARALLEL_API_KEY",
    tool: "web_search",
    arguments: (query) => ({ objective: query, search_queries: [query] }),
    authorize: (_url, headers, key) => {
      headers.Authorization = `Bearer ${key}`;
    },
    results: parallelResults,
  },
  firecrawl: {
    name: "Firecrawl",
    endpoint: "https://mcp.firecrawl.dev/v2/mcp",
    keyEnvironment: "FIRECRAWL_API_KEY",
    tool: "firecrawl_search",
    arguments: (query) => ({ query, limit: 8 }),
    authorize: (_url, headers, key) => {
      headers.Authorization = `Bearer ${key}`;
    },
    results: firecrawlResults,
  },
} satisfies Record<WebSearchProviderId, ProviderDefinition>;

const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = ["exa", "parallel", "firecrawl"];

export interface WebSearchCredentials {
  read(provider: WebSearchProviderId): Promise<string | undefined>;
  write(provider: WebSearchProviderId, key: string | undefined): Promise<void>;
}

export interface WebSearchPluginOptions {
  readonly credentials?: WebSearchCredentials;
  readonly fetch?: typeof globalThis.fetch;
  readonly environment?: (name: string) => string | undefined;
  readonly random?: () => number;
}

export function webSearchCredentialId(provider: WebSearchProviderId): string {
  return `websearch:${provider}`;
}

function isWebSearchProvider(value: string): value is WebSearchProviderId {
  return WEB_SEARCH_PROVIDER_IDS.some((provider) => provider === value);
}

function isWebSearchSelection(value: string): value is WebSearchSelection {
  return value === "auto" || isWebSearchProvider(value);
}

function parseQuery(value: unknown): string {
  if (!Value.Check(webSearchParameters, value)) {
    throw new Error("Web search needs a non-empty query");
  }
  const query = value.query.trim();
  if (query === "") throw new Error("Web search needs a non-empty query");
  return query;
}

function shuffledProviderIds(random: () => number): WebSearchProviderId[] {
  return WEB_SEARCH_PROVIDER_IDS.map((provider) => ({ provider, rank: random() }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ provider }) => provider);
}

function toolResult(body: string): WebSearchMcpResult {
  const trimmed = body.trim();
  const payload = trimmed.startsWith("{")
    ? trimmed
    : body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
  let value: unknown;
  try {
    value = JSON.parse(payload ?? "");
  } catch {
    throw new Error("web search endpoint returned an invalid response");
  }
  if (!Value.Check(JsonRpcResultSchema, value)) {
    throw new Error("web search endpoint returned an invalid response");
  }
  return value.result;
}

async function callProvider(
  providerId: WebSearchProviderId,
  query: string,
  options: { fetch: typeof globalThis.fetch; key?: string; signal?: AbortSignal },
): Promise<WebSearchResult[]> {
  const provider = PROVIDERS[providerId];
  const url = new URL(provider.endpoint);
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "uji/web-search",
  };
  if (options.key !== undefined) provider.authorize(url, headers, options.key);
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    // Public search routes accept direct tools/call, not core's pinned protocol.
    const response = await options.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: provider.tool, arguments: provider.arguments(query) },
      }),
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body.trim() || response.statusText);
    const remote = toolResult(body);
    if (remote.isError === true) {
      throw new Error(textContent(remote) ?? `${provider.tool} returned an error`);
    }
    return provider.results(remote);
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw new Error(
      `${provider.name} web search request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function apiKey(
  provider: WebSearchProviderId,
  credentials: WebSearchCredentials | undefined,
  environment: (name: string) => string | undefined,
): Promise<string | undefined> {
  const stored = await credentials?.read(provider);
  if (stored !== undefined && stored !== "") return stored;
  const ambient = environment(PROVIDERS[provider].keyEnvironment);
  return ambient === undefined || ambient === "" ? undefined : ambient;
}

function formattedResults(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return NO_RESULTS;
  return results
    .map((item) => {
      const title = item.title ?? item.url;
      const published =
        item.published === undefined
          ? ""
          : `\nPublished: ${new Date(item.published).toISOString()}`;
      return `## [${title}](${item.url})${published}${item.content === undefined ? "" : `\n\n${item.content}`}`;
    })
    .join("\n\n");
}

export function createWebSearchTool(
  selection: () => Promise<WebSearchSelection>,
  options: WebSearchPluginOptions = {},
) {
  const fetch = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? ((name: string) => process.env[name]);
  const random = options.random ?? Math.random;
  return {
    name: "websearch",
    description: `Search the web for current information beyond the model's knowledge cutoff. The current year is ${String(new Date().getFullYear())}; include it when searching for recent events.`,
    parameters: webSearchParameters,
    replay: "safe",
    async execute(
      _toolCallId: string,
      rawInput: unknown,
      signal?: AbortSignal,
      onUpdate?: Parameters<HarnessTool["execute"]>[3],
    ) {
      const query = parseQuery(rawInput);
      const selected = await selection();
      const providers = selected === "auto" ? shuffledProviderIds(random) : [selected];
      let lastError: unknown;
      for (const providerId of providers) {
        const provider = PROVIDERS[providerId];
        onUpdate?.({
          content: [{ type: "text", text: `Searching with ${provider.name}…` }],
          details: { provider: providerId, results: [] },
          title: query,
        });
        try {
          const results = await callProvider(providerId, query, {
            fetch,
            key: await apiKey(providerId, options.credentials, environment),
            ...(signal === undefined ? {} : { signal }),
          });
          return {
            content: [{ type: "text", text: formattedResults(results) }],
            details: { provider: providerId, results },
            title: query,
          };
        } catch (error) {
          if (signal?.aborted === true) throw error;
          lastError = error;
        }
      }
      throw lastError ?? new Error("No web search provider is available");
    },
  } satisfies HarnessTool;
}

function providerLabel(provider: WebSearchSelection): string {
  return provider === "auto" ? "automatic" : PROVIDERS[provider].name;
}

/**
 * Commands take their input as arguments; the interactive path is the
 * settings menu. Secrets never enter the conversation: the key rides the
 * command argument or the provider's environment variable.
 */
function chooseProvider(argument: string): WebSearchSelection {
  const requested = argument.trim();
  if (!isWebSearchSelection(requested)) {
    throw new Error(
      `/websearch-provider must be one of: auto, ${WEB_SEARCH_PROVIDER_IDS.join(", ")} ` +
        "(or use the settings menu)",
    );
  }
  return requested;
}

async function configureApiKey(
  provider: WebSearchProviderId,
  credentials: WebSearchCredentials,
  key: string,
): Promise<string> {
  const definition = PROVIDERS[provider];
  await credentials.write(provider, key === "" ? undefined : key);
  return key === "" ? `Removed ${definition.name} API key.` : `Saved ${definition.name} API key.`;
}

export function webSearchPlugin(options: WebSearchPluginOptions = {}) {
  const environment = options.environment ?? ((name: string) => process.env[name]);
  const credentials = options.credentials;
  return definePlugin({
    id: WEB_SEARCH_PLUGIN_ID,
    session(api) {
      const selection = async (): Promise<WebSearchSelection> => {
        const override = environment(WEB_SEARCH_PROVIDER_ENV);
        if (override !== undefined) {
          if (!isWebSearchSelection(override)) {
            throw new Error(
              `${WEB_SEARCH_PROVIDER_ENV} must be one of: auto, ${WEB_SEARCH_PROVIDER_IDS.join(", ")}`,
            );
          }
          return override;
        }
        const stored = await api.storage.get(PROVIDER_KEY);
        return typeof stored === "string" && isWebSearchSelection(stored) ? stored : "auto";
      };

      api.settings.add((settings) =>
        settings.set("websearch-provider", {
          label: "Web search",
          key: PROVIDER_KEY,
          fallback: "auto",
          choices: [
            {
              id: "auto",
              label: "automatic",
              description: "Use keyless routes in random order and fall back on errors",
            },
            ...WEB_SEARCH_PROVIDER_IDS.map((provider) => ({
              id: provider,
              label: PROVIDERS[provider].name,
              description: `Always use ${PROVIDERS[provider].name}`,
            })),
          ],
        }),
      );

      api.commands.add((commands) => {
        commands.set("websearch-provider", {
          description: "Choose automatic or fixed web search routing",
          run: async (argument) => {
            const provider = chooseProvider(argument);
            await api.storage.set(PROVIDER_KEY, provider);
            return `Web search provider: ${providerLabel(provider)}`;
          },
        });
        if (credentials !== undefined) {
          commands.set("websearch-key", {
            description:
              "Save or remove an optional web search API key: /websearch-key <provider> [key]",
            run: async (argument) => {
              const [provider, ...rest] = argument.trim().split(/\s+/u);
              if (provider === undefined || !isWebSearchProvider(provider)) {
                throw new Error(
                  `/websearch-key must name one of: ${WEB_SEARCH_PROVIDER_IDS.join(", ")}`,
                );
              }
              return configureApiKey(provider, credentials, rest.join(" ").trim());
            },
          });
        }
      });

      const tool = createWebSearchTool(selection, options);
      api.tools.add((tools) => tools.set(tool.name, tool));
    },
  });
}

export default webSearchPlugin();
