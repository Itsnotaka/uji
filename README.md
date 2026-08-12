# June

June is an independent, handwritten core for building cross-platform agentic
UI. The design is still taking shape in [blueprint.md](./blueprint.md); source
references live in [references.md](./references.md).

The repository is a pnpm + turborepo workspace (opencode2-style layout, no
build step — Node 24 runs TypeScript sources directly):

- `packages/schema` — wire item types shared by everything
- `packages/ai` — provider auth blocks (pi-shaped), OAuth flows, streamed
  Responses client
- `packages/core` — session, tools, and the agent loop
- `packages/demo-cli` — `@june/demo`, the login funnel CLI and coding-agent run
- `packages/demo/grok-bot` — clean-room Grok Bot chat showcase
- `packages/demo/website` — cmdk-style index for June UI studies

Toolchain: mise provides Node.js 24 and pnpm 11; TypeScript 7 native `tsc`
per package via turbo; Oxlint (type-aware via `oxlint-tsgolint`) and Oxfmt at
the root.

## Setup

```sh
mise install
pnpm install
pnpm check
```

## Try it

```sh
pnpm june login            # ChatGPT OAuth (browser or device code); no API key needed
pnpm june "list the files here and summarize"
pnpm june status           # stored credentials
```

Defaults to the `openai-codex` provider with `gpt-5.6-luna` at medium
reasoning effort; override with `--provider`, `--model`, `--effort`, or
`JUNE_MODEL` / `JUNE_EFFORT`.

## Demo apps

Run the two Vite apps in separate terminals:

```sh
pnpm dev:grok-bot  # http://127.0.0.1:5173
pnpm dev:website   # http://127.0.0.1:5174
```

The Grok Bot demo is a mock-backed, clean-room UI study. The showcase site
also documents OpenCrew as a cautionary interaction reference; neither demo
copies product code into `@june/core`.

Use `pnpm format` to write formatting changes. `pnpm lint` runs type-aware
Oxlint, and `pnpm typecheck` runs TypeScript 7 through turbo.
