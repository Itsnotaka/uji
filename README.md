<p align="center">
  <img alt="uji" src="https://raw.githubusercontent.com/Itsnotaka/uji/main/packages/docs/public/brand/uji-icon.svg" width="128">
</p>
<p align="center">
  <a href="https://github.com/Itsnotaka/uji/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/Itsnotaka/uji?style=flat-square"></a>
  <a href="https://github.com/Itsnotaka/uji/releases/latest"><img alt="macOS Apple silicon" src="https://img.shields.io/badge/macOS-Apple_silicon-black?style=flat-square"></a>
</p>

# Uji

Uji is an agent harness with a terminal client. Durable sessions that survive a
crash and resume, an agent loop with tool calling, provider auth, and the
clients that attach to them.

* **[@uji-ai/core](packages/core)**: agent loop, harness, SQLite sessions, plugins, skills,
  compaction, hooks, and the tools: read, bash, edit, write, grep, find, ls
* **[@uji-ai/ai](packages/ai)**: unified multi-provider API. OpenAI, Anthropic, Google,
  OpenCode. Credentials, OAuth, event streams
* **[@uji-ai/schema](packages/schema)**: neutral `Message`, `Model`, `Tool`, and `Skill` contracts
* **[@uji-ai/plugin](packages/plugin)**: `definePlugin` and the types a plugin file imports
* **[@uji-ai/tui](packages/tui)**: the `uji` CLI. An OpenTUI app with print mode

To learn more, read the [design record](packages/docs/content/docs/design.mdx): the chosen
path, the reasoning, the contracts, and the build order.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh
```

macOS (Apple silicon) binaries are on
[GitHub Releases](https://github.com/Itsnotaka/uji/releases). The script verifies the sha256
and installs to `~/.local/bin`. Then log in and run:

```sh
uji login
uji
```

Installed copies update themselves with `uji update`. One prompt without the full screen:

```sh
uji -p "summarize the files in packages/core/src"
```

## Trust and permissions

Uji asks once per directory whether you trust it. That is the only permission gate. A trusted
workspace lets the tools read files, run shell commands, and edit code with your process's
access. There are no per-tool prompts. If you need stronger boundaries, containerize or
sandbox the process; nothing in the harness assumes the host is safe.

## All packages

Library and app packages are private to this workspace. `uji-ai` on npm reserves the `uji`
bin. "Shipped" means the source is here and runs.

| Package | Description |
| --- | --- |
| **[@uji-ai/schema](packages/schema)** | Wire contracts: `Message`, `Model`, `Tool`, `Skill` |
| **[@uji-ai/ai](packages/ai)** | Provider adapters, credentials, OAuth, model catalogs |
| **[@uji-ai/core](packages/core)** | Loop, harness, session storage, plugins, skills, tools |
| **[@uji-ai/plugin](packages/plugin)** | Plugin authoring surface; the host lives in core |
| **[@uji-ai/telemetry](packages/telemetry)** | `TelemetryContext`; the default records nothing |
| **[@uji-ai/ui](packages/ui)** | Shared Base UI components in StyleX |
| **[@uji-ai/tui](packages/tui)** | The terminal client |
| **[uji-ai](packages/cli)** | npm placeholder reserving the `uji` bin |

## Development

pnpm only. `mise.toml` pins Node 26 and Bun 1.3.14. `grep` and `find` shell out to `rg`.

```sh
mise install
pnpm install
pnpm format && pnpm lint && pnpm typecheck
pnpm --dir packages/tui test
```

Run from source:

```sh
pnpm --dir packages/tui start login
pnpm --dir packages/tui start
```

The docs site lives in [packages/docs](packages/docs):

```sh
cd packages/docs && pnpm dev    # http://localhost:3000
```

When a page and the source disagree, the source wins.
