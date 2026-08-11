# June

June is an independent, handwritten core for building cross-platform agentic
UI. The design is still taking shape in [blueprint.md](./blueprint.md); source
references live in [references.md](./references.md).

The repository currently has a minimal TypeScript toolchain:

- mise provides Node.js 24 and pnpm 11.
- TypeScript 7 provides the native `tsc` compiler formerly previewed as
  `tsgo`.
- Oxlint uses `oxlint-tsgolint` for type-aware rules.
- Oxfmt formats the repository.

## Setup

```sh
mise install
pnpm install
pnpm check
```

Use `pnpm format` to write formatting changes. `pnpm lint` runs type-aware
Oxlint, and `pnpm typecheck` runs TypeScript 7 directly.
