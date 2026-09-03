# docs

The Uji documentation site. Content lives in `content/docs`. The [design record](content/docs/design.mdx)
is the contract; other pages describe what shipped.

```bash
pnpm --dir packages/docs dev
```

Open http://localhost:3000. Root `pnpm dev` starts the **demo** desktop, not this site.

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
`packages/docs`. Vercel detects the Turborepo monorepo and the Next.js app from
that project root, so there is no checked-in `vercel.json` overriding its
install, build, output, or ignored-build settings.

The root `.vercelignore` excludes sibling workspaces, generated binaries, and
local Uji state. A root `vercel` command uploads only `packages/docs` plus the
root pnpm and Turborepo metadata required to identify and install that
workspace.

`@uji-ai/core` cannot reach the client bundle because it is not in this
package's dependency graph.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
