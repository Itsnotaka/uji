# docs

This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

Open http://localhost:3000 with your browser to see the result.

## Explore

In the project, you can see:

- `lib/source.ts`: Code for content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) provides the interface to access your content.
- `lib/layout.shared.tsx`: Shared options for layouts, optional but preferred to keep.

| Route                     | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `app/(home)`              | The route group for your landing page and other pages. |
| `app/docs`                | The documentation layout and pages.                    |
| `app/api/search/route.ts` | The Route Handler for search.                          |

### Fumadocs MDX

Collections are defined with the [Macro API](https://fumadocs.dev/docs/mdx/macro) in `lib/source.ts`.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Deploying

Vercel project: `interface-co/uji-docs`, with **Root Directory** set to
`packages/docs`. `vercel.json` carries three settings, and each is load-bearing
(the file is JSON, so the reasoning lives here):

- **`installCommand`** — `pnpm install --filter docs... --frozen-lockfile`.
  `docs` declares no `workspace:` dependencies, so `docs...` resolves to `docs`
  alone. Without the filter Vercel installs all eight workspace packages, which
  pulls Electron 42 and `electron-builder` down for `packages/demo/desktop` on
  a build that never touches it.
- **`buildCommand`** — `pnpm build`, this package's own `next build`.
- **`ignoreCommand`** — `git diff --quiet HEAD^ HEAD -- .`, run from this
  directory. Exit 0 means "nothing here changed, skip the build", so a commit
  that only touches `@uji-ai/core` does not redeploy the site. On a shallow clone
  with no `HEAD^` it exits non-zero, which fails safe by building.

`@uji-ai/core` cannot reach the client bundle: it is not in this package's
dependency graph at all. The install filter is about install time and build
minutes, not bundle size.

The root `.vercelignore` drops build output only. Every workspace manifest and
the lockfile stay in the upload, because `--frozen-lockfile` compares the
lockfile against the whole workspace and a missing package directory fails the
install.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
