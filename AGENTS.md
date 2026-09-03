# Uji

The design record is `packages/docs/content/docs/design.mdx`: the chosen path,
the reasoning, the contracts, and the build order. Read it before changing core
shapes; when it and any other document disagree on a contract, it wins.

Ported files keep their `Based on <link>` credit. `THIRD-PARTY-NOTICES.md` at
the root lists the upstreams; external reading lives in
`packages/docs/content/docs/references.mdx`.

- Use pnpm, never npm. Do not create `package-lock.json`.
- After code changes, run `pnpm format`, `pnpm lint`, and `pnpm typecheck` from
  the repository root.
- Start the TUI with `pnpm --dir packages/tui start`.
- Put anything needed by the agent loop or conversation in core, even when no
  client renders it yet. Keep expensive transforms in hosts or extensions and
  presentation in clients.
