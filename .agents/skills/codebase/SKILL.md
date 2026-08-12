---
name: codebase
description: >-
  Manages and searches agent-readable local copies of repos and packages via the
  `codebase` CLI. Stable symlinks live under ~/.agents/codebases/<name>. Invoke
  when a task needs source outside the current workspace, upstream repo/package
  context, package internals, docs from a registered mirror, a predictable local
  source path, or searches across registered codebases. Start with `codebase
  list`; use FFF-backed `codebase grep <name> <query>` for content search before
  `rg`, `grep`, `find`, broad shell scans, cloning fresh, or answering from
  memory. Use `codebase path <name>` only after selecting a registered mirror,
  and mainly for reading known files or running narrow follow-up commands. Also
  use when adding/updating upstream sources, resolving paths, listing
  registrations, sparse checkouts, or when the user mentions ~/.agents/codebases,
  codebase-cli, or local mirrors for agents.
---

# codebase CLI

## Paths

- **Stable symlinks**: `~/.agents/codebases/<name>` (override root with `CODEBASE_HOME`).
- **Managed cache**: `~/.agents/codebases/.cache`
- **Registry**: `~/.agents/codebases/.state/registry.json`

Prefer reading and editing through `~/.agents/codebases/<name>` after registration; treat `.cache` as internal.

## Resource specs

Canonical forms:

- `github:owner/repo`
- `git:https://host/owner/repo.git`
- `npm:package@version`
- `local:/absolute/path`

GitHub URLs and shorthand like `owner/repo` are accepted where documented.

## Common commands

```bash
codebase add github:owner/repo --name my-alias
codebase add git:https://example.com/org/repo.git --name repo
codebase add npm:react@latest --name react-pkg
codebase add local:/absolute/path/to/dir --name project
codebase list
codebase list --json
codebase path my-alias
codebase info my-alias
codebase status my-alias
codebase grep my-alias "query"
codebase grep my-alias "*.ts query" --context 2
codebase update my-alias
codebase update --all
codebase remove my-alias
codebase doctor
codebase prune
codebase self-update
```

Sparse checkout (large repos):

```bash
codebase add github:owner/huge --name subset --path docs
codebase add github:owner/huge --name subset --path compiler,src
```

`local:` resources are verified on update but not rewritten.

## Agent Workflow

1. If the user needs source outside the current workspace, run `codebase list` before cloning, answering from memory, using `~/.agents/codebases` directly, or setting `root="$(codebase path ...)"`.
2. For content search, use `codebase grep <name> <query>` first. This replaces first-pass commands like `rg -n "entry|tree|parent" "$root/packages"`.
3. Try a few targeted `codebase grep` queries before falling back to raw shell search: symbols, API names, package names, file globs, and relevant concepts.
4. Use `codebase path <name>` only after you have selected the mirror and need to read a known file, inspect structured metadata, or run a narrow follow-up command.
5. Use `find "$root" ...` only for file inventory when grep cannot start because you do not know likely symbols, filenames, or docs.
6. If the needed source is missing, register it with `codebase add` and confirm with `codebase path <name>`.
7. Refresh sources with `codebase update <name>` when answers depend on current upstream state.

## Recommended Patterns

Search registered code first:

```bash
codebase list
codebase grep badlogic-pi-mono "entry tree parent" --context 2 --limit 80
codebase grep badlogic-pi-mono "packages entry" --context 2 --limit 80
codebase grep badlogic-pi-mono "*.ts entry" --context 2 --limit 80
```

Then inspect a specific file from the search result:

```bash
root="$(codebase path badlogic-pi-mono)"
sed -n '1,220p' "$root/packages/path/from/grep.ts"
```

Read structured metadata after resolving the mirror:

```bash
root="$(codebase path t3code-full)"
bun -e 'const p = await Bun.file(`${process.argv[1]}/package.json`).json(); console.log(JSON.stringify(p.scripts, null, 2));' "$root"
```

Use inventory only when needed:

```bash
root="$(codebase path t3code-full)"
find "$root" -maxdepth 2 -type f | sed "s#$root/##" | sort | head -80
```

## Avoid As First Move

```bash
root="$(codebase path badlogic-pi-mono)" && rg -n "entry|tree|parent" "$root/packages" | head -200
rg -n "entry|tree|parent" /Users/me/.agents/codebases/badlogic-pi-mono/packages
find /Users/me/.agents/codebases/t3code-full -maxdepth 2 -type f
node -e "const p=require('/Users/me/.agents/codebases/t3code-full/package.json')"
```
