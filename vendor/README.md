# vendor

Prebuilt packages that cannot be installed from their upstream source directly.

## electron-vite

`electron-vite-6.0.0-beta.1-608461c.tgz` is built from
https://github.com/alex8088/electron-vite at commit
`608461c04cf74cbf27b47f9916e10e225cbfe8f1` (master, 2026-08-18).

The upstream repo has no `prepare` script and `dist/` is gitignored, so pnpm
cannot install it from a git URL. Rebuild with:

```sh
git clone https://github.com/alex8088/electron-vite.git
cd electron-vite && git checkout <commit>
pnpm install --frozen-lockfile
pnpm exec rollup -c rollup.config.ts --configPlugin typescript
pnpm pack
```

Copy the tarball here with the short commit hash in its name and update the
`electron-vite` entries in `packages/desktop` and `packages/demo/desktop`.
