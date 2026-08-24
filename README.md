# Uji

Uji is a handwritten core for agentic UI. Durable sessions, an agent loop, provider auth, and the
clients that attach to them.

Docs live in [`packages/docs`](./packages/docs). From that directory, `pnpm dev`. The design record
is the docs [design page](./packages/docs/content/docs/design.mdx). When a page and the source
disagree, the source wins.

## Install

macOS (Apple silicon) builds are on [GitHub Releases](https://github.com/Itsnotaka/uji/releases).

```sh
curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh
```

The script downloads the newest release tarball, verifies the sha256, and puts `uji` in
`~/.local/bin`. Set `UJI_INSTALL_DIR` to install somewhere else. Then `uji login` and run.

## What it is

`runAgentLoop` takes a `StreamFn`, an `AgentTool[]`, and an event sink. It imports wire types from
`@uji-ai/schema` and nothing else. `AgentHarness` runs that same loop against `SessionStorage` and
writes records before each effect, so a crash can be resumed. Plugins, skills, compaction, and
hooks attach to the harness.

The CLI and the Electron app both drive a harness. Neither is the product. This repo does not
import another project's harness and wrap it.

## Packages

Library and app packages stay private. `uji-ai` on npm is a `0.0.1` placeholder that reserves the
`uji` bin. "Shipped" means the source is in this workspace and runs.

| Package | What it is | Status |
| --- | --- | --- |
| `@uji-ai/schema` | Neutral `Message`, `Model`, `Tool`, and `Skill` contracts | Shipped |
| `@uji-ai/ai` | `Models`, provider adapters, credentials, OAuth, event streams | Shipped |
| `@uji-ai/core` | Loop, `AgentHarness`, SQLite sessions, plugins, skills, compaction, hooks, workspace trust, and the seven tools: read, bash, edit, write, grep, find, ls | Shipped |
| `@uji-ai/plugin` | `definePlugin` and the types a plugin file imports. The host lives in core | Shipped |
| `@uji-ai/telemetry` | `TelemetryContext` on `Context`. `NOOP_TELEMETRY_CONTEXT` records nothing | Shipped |
| `@uji-ai/ui` | Shared Base UI components in StyleX | Shipped |
| `@uji-ai/tui` | The `uji` CLI: OpenTUI app, print mode, login, macOS Bun binary | Shipped |
| `uji-ai` | Public npm package for the `uji` bin | Placeholder published |
| `@uji-ai/demo-desktop` | Electron chat. Main process hosts the harness, renderer uses a preload API | Demo |
| `@uji-ai/cli` | Print and chat CLI in `packages/demo/cli`. Not the product client | Demo |
| `@uji-ai/demo-website` | TanStack Start marketing site. Does not run a harness | Demo |
| `docs` | Fumadocs site in `packages/docs` | Shipped |
| `@uji-ai/protocol`, `@uji-ai/server`, `@uji-ai/client`, `@uji-ai/util` | Names locked by the package map | Reserved, not built |

Still unbuilt: the wire packages, a remote tool host, and a telemetry exporter. Compaction, hooks,
plugins, and skills are in core. [Roadmap](./packages/docs/content/docs/roadmap.mdx) tracks the
gaps.

## Setup

pnpm only. `pnpm-lock.yaml` and the root `packageManager` field are the pin. Do not generate
`package-lock.json`. `mise.toml` pins Node 26 and Bun 1.3.14. `package.json` pins pnpm 11.22.0.
`grep` and `find` shell out to `rg` on `PATH`.

```sh
mise install
pnpm install
pnpm format
pnpm lint
pnpm typecheck
```

## Terminal client

The product CLI is `packages/tui`. Log in, then run. `pnpm start --help` prints usage and exits 0.

```sh
cd packages/tui
pnpm start login
pnpm start status
pnpm start
pnpm start --resume
pnpm start --resume <session-id>
pnpm start -p "summarize the files in packages/core/src"
pnpm start -p --resume "now list what changed"
echo "list the TypeScript files here" | pnpm start -p
pnpm start logout
```

On macOS, `pnpm build:cli` from the repo root writes `bin/uji` with the TUI package version.

```sh
pnpm build:cli
./bin/uji --version
./bin/uji
```

`start` and `dev` run under Bun. Tests run under Node with `--experimental-ffi`.

```sh
cd packages/tui
pnpm test
node --experimental-ffi --test test/render.test.ts
```

`pnpm dev` writes a JSONL render log to `$UJI_HOME/logs`, default `~/.uji/logs`. A clean exit ends
with `renderer_destroyed` and `render_log_closed`. Set `UJI_TUI_RENDER_LOG=/tmp/uji-tui.jsonl` to
log a `pnpm start` run. The TUI checks GitHub Releases for a newer version in the
background. `UJI_SKIP_VERSION_CHECK=1` or `UJI_OFFLINE=1` skips that request.

### Commands

| Command | Effect |
| --- | --- |
| `uji` | Open the full-screen TUI |
| `uji login [provider]` | Log in, default provider `openai-codex` |
| `uji logout [provider]` | Delete the stored credential |
| `uji status` | Print `providerId: type` per credential, or `no stored credentials` |
| `uji --version` | Print the package version |

Registered providers: `openai-codex`, `openai`, `anthropic`, `opencode`, `opencode-go`.

### Flags

| Flag | Alias | Effect |
| --- | --- | --- |
| `--print` | `-p` | Stream one run to stdout and exit |
| `--json` | | Emit JSONL on stdout |
| `--quiet` | `-q` | Hide tool-start lines |
| `--resume [<session-id>]` | `-c` | Open the newest session, or a session id in the TUI |
| `--provider <id>` | | Override the saved provider |
| `--model <id>` | | Override the saved model |
| `--effort <level>` | | Set thinking level |

`--effort` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Anything else fails
before the harness opens: `Unknown effort: <value>. Use off, minimal, low, medium, high, xhigh, max`.

`--json` and `--quiet` select print mode even without `-p`. A missing print prompt is read from
stdin. Empty stdin prints usage and exits 1. Non-TTY stdout with a prompt, or piped stdin, also
prints. In print mode, leftover argv after flags is the prompt, including after bare `--resume`.

### Print mode

Trust the workspace in the TUI first. Print mode does not prompt. An untrusted cwd fails with
`Workspace is not trusted: <cwd>. Run \`uji\` interactively to trust it first.` No stored
credential fails with `Couldn't find a stored credential. Run \`uji login\`.`

Human output: text deltas on stdout, tool titles on stdout unless `--quiet`, errors on stderr as
`error: <message>`. A finished run prints `session <id> · <provider> · <kind>` on stderr, then
`resume with: uji -p --resume`.

`--json` writes one JSON object per line on stdout and keeps diagnostics off that stream:

```json
{"type":"text","text":"…"}
{"type":"tool","name":"bash","title":"…"}
{"type":"result","session":"<id>","provider":"openai-codex","kind":"finished"}
{"type":"error","message":"…"}
```

Ctrl-C exits 130. SIGTERM exits 143.

### Trust, skills, plugins

The TUI asks for workspace trust before it opens project plugins, skills, sessions, or tools. That
is the only permission gate. After trust, tools run with the host process's access. No per-tool
prompts.

Skills are `SKILL.md` folders under project and user `.uji/skills`, `.agents/skills`, and
`.claude/skills`. Type `/` in the composer, or `ctrl+k` for commands and `ctrl+s` for skills. Run
`/<skill-name> [instructions]` to invoke one. `/reload` rebuilds both catalogs from disk.

`/fast` comes from a host plugin the TUI preinstalls. The command appears only when the model
advertises fast inference. The choice is stored per session and per provider. The `question` tool
in `packages/plugin/examples` is opt-in. It is not part of the client and does not gate filesystem
or shell tools.

### Settings and keys

| Key | Effect |
| --- | --- |
| `ctrl+p` | Cycle models |
| `shift+tab` | Cycle thinking |
| `ctrl+g` | Edit the draft in `externalEditor`, `$VISUAL`, or `$EDITOR` |
| `/settings` | Edit model, thinking, auto-compaction, and transport under the transcript |

Global settings: `$UJI_HOME/settings.json`, default `~/.uji/settings.json`. Trusted project
overrides: `<cwd>/.uji/settings.json`. Project fields win. Nested `compaction` fields merge field
by field.

Resolution order for provider: `--provider`, project settings, global settings, then the first
registered provider whose auth resolves. Cold start is `openai-codex`. Model: `--model`,
`UJI_MODEL`, settings, then the provider default. OpenAI providers use `gpt-5.6-luna`. Thinking:
`--effort`, `UJI_EFFORT`, settings, then `medium`.

Credentials: `$UJI_HOME/auth.json`, default `~/.uji/auth.json`, mode `0600`. Sessions:
`<cwd>/.uji/sessions.db`.

## Demos

Desktop lives in `packages/demo/desktop`. `src/main/uji-host.ts` opens `SqliteSessionRepo` and an
`AgentHarness` per conversation, and runs ChatGPT OAuth. The renderer talks through
`src/desktop-api.ts`. Uji, Draft, and Scout all run. No coding tools: `AgentHarness.create` gets a
system-prompt plugin, not `createAllTools`. The preload API is this demo's IPC, not
`@uji-ai/protocol`.

`packages/demo/cli` is a second print and chat CLI on the same core. Use `packages/tui`.

`packages/demo/website` is a marketing site. It does not import `@uji-ai/core`.

```sh
cd packages/demo/desktop
pnpm dev                 # electron-vite; opens a desktop window, not a URL

cd packages/demo/cli
pnpm start

cd packages/demo/website
pnpm dev                 # http://127.0.0.1:5174
```

## Development

```sh
pnpm format       # check formatting
pnpm format:fix   # write formatting fixes
pnpm lint         # oxlint, type-aware via oxlint-tsgolint
pnpm lint:fix     # write safe lint fixes
pnpm typecheck    # turbo run typecheck
```

`packages/core`: `pnpm test` runs `node:test` files, then the loop suite under Vitest.

No build step for the libraries. `@uji-ai/schema`, `@uji-ai/ai`, `@uji-ai/core`, `@uji-ai/plugin`,
`@uji-ai/telemetry`, and `@uji-ai/ui` export TypeScript sources. Node 26 strips types at load.
`pnpm typecheck` emits nothing. Demo apps and docs have `build` scripts because Vite, Electron, and
Next need them.

## Docs

```sh
cd packages/docs
pnpm dev          # next dev, http://localhost:3000
pnpm build        # next build
```

MDX lives under `packages/docs/content/docs`. Sidebar order is the two `meta.json` files: getting
started, package pages, host-sdk, design, roadmap. The `core` section is `index`, `agent-loop`,
`harness`, `session-storage`, `tools`, `stream-fn`, `recipes`.
