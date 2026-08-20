# June

June is an independent, handwritten core for building cross-platform agentic UI: a durable
agent harness, a standalone agent loop, provider auth blocks, and the clients that attach to them.

Docs live in [`packages/docs`](./packages/docs) (fumadocs; from that directory, `pnpm dev`). Intent and dated
design decisions live in [blueprint.md](./blueprint.md); source references live in
[references.md](./references.md).

## What it is

`@june/core` ships two entry points over one primitive. `runAgentLoop` is a standalone loop that
imports nothing but wire types from `@june/schema`: you inject a `StreamFn`, an `AgentTool[]`, and
an event sink. `AgentHarness` composes that same loop over a `SessionStorage`, bracketing each run
with durable records so a crash can be resumed. Clients (the CLI, the Electron app) are peers
that drive a harness; none of them is the product, and none of another project's harness is
imported or wrapped as the implementation.

## Packages

Every package is `private` and unpublished. "Shipped" means the source exists in this workspace and
runs, not that it is on npm.

| Package | What it is | Status |
| --- | --- | --- |
| `@june/schema` (`packages/schema`) | Neutral `Message`, `Model`, `Tool`, and request-context contracts | Shipped |
| `@june/ai` (`packages/ai`) | `Models`, provider adapters, credential storage, OAuth, and provider event streams | Shipped |
| `@june/core` (`packages/core`) | The `Message` loop and types, `AgentHarness`, `SqliteSessionRepo`, and seven tools (read, bash, edit, write, grep, find, ls) | Shipped |
| `@june/ui` (`packages/ui`) | Shared Base UI primitives styled with StyleX: avatar, button, dialog, dropdown menu, input, input group, textarea | Shipped |
| `@june/demo` (`packages/demo/cli`) | The `june` CLI: OpenTUI full-screen app, `-p` print mode, readline login funnel | Shipped |
| `@june/demo-grok-bot` (`packages/demo/grok-bot`) | Electron desktop chat; the main process hosts the harness, the renderer sees a preload API | Demo |
| `@june/demo-website` (`packages/demo/website`) | TanStack Start marketing site; it does not run a harness | Demo |
| `docs` (`packages/docs`) | The fumadocs documentation site | Shipped |
| `@june/protocol`, `@june/server`, `@june/client`, `@june/util`, `@june/plugin` | Names locked by the blueprint's package map | Reserved, not built |

Not built yet: the multi-client wire (`protocol`/`server`/`client`), a remote tool host, context
compaction, hooks, and telemetry spans. `packages/docs/content/docs/roadmap.mdx` measures each gap
against the specification the harness is ported from.

## Setup

`mise.toml` pins Node 26, pnpm 11.21.0, and bun 1.3.14. The `grep` and `find` tools shell out to
`rg` (ripgrep) on `PATH`.

```sh
mise install
pnpm install
pnpm check
```

## Demos

The CLI lives in `packages/demo/cli`. It has no bin and no root script. From that directory,
`pnpm start` runs the TypeScript source. Log in first; it has no `--help`, and usage prints only
on the two failure paths.

```sh
cd packages/demo/cli
pnpm start login
pnpm start status
pnpm start
pnpm start -p "summarize the files in packages/core/src"
pnpm start -p --resume "now list what changed"
pnpm start logout
```

| Flag | Alias | Effect |
| --- | --- | --- |
| `--print` | `-p` | Non-interactive run: stream deltas to stdout and exit |
| `--resume` | `-c` | Open the newest existing session instead of creating one |
| `--provider <id>` | none | Force a provider instead of auto-selecting |
| `--model <id>` | none | Model passed to the harness; falls back to `JUNE_MODEL` |
| `--effort <level>` | none | Thinking level passed to the harness; falls back to `JUNE_EFFORT` |

Provider auto-selection walks the CLI's explicitly registered providers (`openai-codex`, then `openai`)
and takes the first whose auth resolves. Both default to `gpt-5.6-luna`; the CLI defaults to `medium`
effort. Credentials are
written to `$JUNE_HOME/auth.json` (default `~/.june/auth.json`, mode `0600`). Sessions go to
`<cwd>/.june/sessions.db`, one SQLite file holding every session started from that directory.

`grok-bot` is a real composition, not a mock: `src/main/june-host.ts` opens a `SqliteSessionRepo`,
creates an `AgentHarness`, and drives the ChatGPT OAuth flow, while the sandboxed renderer talks to
it only through the preload API in `src/desktop-api.ts`. The shipped surface is five IPC methods
(sign in, stream text, stop, new chat, local history), and the session needs no workspace folder.
It registers no tools: `AgentHarness.create` is called without `tools`. Only the `june`
agent in the sidebar is live; the other three entries in `src/demo-data.ts` are static previews
that do not run.

`website` is a marketing site about the desktop app. It renders a static preview component; it does
not import `@june/core` or simulate a harness.

```sh
cd packages/demo/grok-bot
pnpm dev                 # electron-vite; opens a desktop window, not a URL

cd packages/demo/website
pnpm dev                 # http://127.0.0.1:5174
```

## Development

```sh
pnpm check        # format:check, then lint, then turbo run typecheck
pnpm format       # oxfmt . (writes)
pnpm lint         # oxlint, type-aware via oxlint-tsgolint
pnpm typecheck    # turbo run typecheck (TypeScript 7 native tsc per package)
```

From `packages/core`: `pnpm test` runs June's `node:test` files and the loop conformance suite under Vitest.

There is no build step for the library packages. `@june/schema`, `@june/ai`, `@june/core`, and
`@june/ui` each point `exports` at their TypeScript sources, and Node 26 strips types at load time.
`pnpm check` compiles nothing and emits nothing. The demo apps and the docs site have their own
`build` scripts because Vite, Electron, and Next need them.

## Docs

```sh
cd packages/docs
pnpm dev          # next dev, http://localhost:3000
pnpm build        # next build
```

Pages are MDX under `packages/docs/content/docs`: `index`, `quickstart`, `architecture`,
`principles`, `host-sdk`, `roadmap`, and a `core` section holding `core/index`, `agent-loop`,
`harness`, `session-storage`, `tools`, `stream-fn`, and `recipes`. Sidebar order is set by the two `meta.json`
files. When a page and the source disagree, the source wins and the page is wrong.
