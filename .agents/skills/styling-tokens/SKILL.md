---
name: styling-tokens
description: Token-driven styling across StyleX, Tailwind, and plain CSS — one CSS-variable vocabulary
---

# Token-driven styling

Three styling layers, one token vocabulary. Every layer resolves to the same CSS custom properties,
so theming — dark mode included — works regardless of which layer painted the pixel. Adapted from
[facebook/astryx](https://github.com/facebook/astryx) (`tailwind-theme.css` `@theme inline` bridge,
`styling.doc.mjs`, CLAUDE.md STYLEX-CAPS). Examples use honk's `--honk-*` names; the prefix is
per-project, the structure is not.

## The three layers

| Layer                 | Owns                                                                                | Mechanism                                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| StyleX                | Component primitives: variants, states, pseudo-classes, caller overrides            | `stylex.create()` reading tokens from `stylex.defineVars`                 |
| Tailwind v4 utilities | Layout and wrapper styling: flex/grid/gap/padding on containers                     | Utility names aliased to token vars via a pure-CSS `@theme inline` bridge |
| Plain CSS             | Substrate: globals, resets, vendor baseline imports, native/Electron chrome escapes | `var(--honk-*)` directly                                                  |
| CSS modules           | Component-scoped third-party DOM adapters whose markup cannot receive StyleX props  | Scoped selectors + `var(--honk-*)`                                        |

No other mechanism (broad inline `style=`, styled-components, a second token system) without a
decision record. CSS modules are not a general component-authoring channel.

### Agent rule of thumb

| You are styling…                                                         | Use                                    |
| ------------------------------------------------------------------------ | -------------------------------------- |
| A component primitive (button, tab, card — variants, hover, focus)       | StyleX + token vars                    |
| A page/section layout wrapper (flex row, grid, gutters, one-off spacing) | Tailwind utilities                     |
| Globals, resets, vendor baseline imports, window/Electron chrome         | Plain CSS + `var(--honk-*)`            |
| Third-party widget internals under one owning component                  | Colocated CSS module + `var(--honk-*)` |

Component overrides go through the component's StyleX override prop (`xstyle` or the project's
equivalent), not `className`. `className` is a layout channel, never an override channel.

## Dependency diagram

One source file defines the vocabulary; everything else reads it.

```
renderer-neutral theme source (Honk: packages/ui/src/theme.ts)
        │ generated projection
        ▼
platform token binding with literal "--honk-*" keys
        │  compiled to CSS custom properties on the page
        ▼
:root { --honk-color-accent: light-dark(#3685bf, #599ce7); … }
        │                      │                        │
        ▼                      ▼                        ▼
  StyleX create()        Tailwind bridge           plain CSS
  colorVars["--honk-     @theme inline aliases     var(--honk-color-accent)
  color-accent"]         → bg-accent, text-accent
```

Token _values_ change in exactly one authored file; call sites in every layer reference names only.

Generated token-binding shape (see the stylex skill for full rules): one `defineVars` per concern
over a plain `*Defaults` object, keys are the literal `--honk-*` custom-property names, read by
bracket. In Honk, edit `theme.ts` and run `pnpm --filter @honk/ui sync:tokens`:

- good: `backgroundColor: colorVars["--honk-color-bg-base"]`
- bad: `backgroundColor: colorVars.bgBase` / `backgroundColor: "#161616"`

## The Tailwind bridge

A pure-CSS file (zero JS — in honk: `packages/ui/src/tailwind.css`) aliases Tailwind v4 theme
variables to the token vars. `@theme inline` registers the variables Tailwind generates utilities
from **without emitting values** — each utility resolves through `var()` at paint time, so theme
flips propagate to Tailwind-styled elements for free.

```css
@theme inline {
  --color-accent: var(--honk-color-accent);
  --color-layer-01: var(--honk-color-layer-01);
  --color-text-muted: var(--honk-color-text-muted);
  --spacing-gutter: var(--honk-space-gutter);
  --spacing-panel-pad: var(--honk-space-panel-pad);
  --radius-panel: var(--honk-radius-panel);
}
```

- good: `className="flex gap-gutter bg-layer-01 rounded-panel p-panel-pad"`
- bad: `className="bg-[#242424] rounded-[10px] p-[12px]"` (raw values bypass the vocabulary)
- acceptable fallback when no alias exists yet: arbitrary value **through the var** —
  `className="bg-[var(--honk-color-layer-01)]"` — then add the alias to the bridge.

Keep the bridge semantic and small: alias the tokens the project uses, named to read naturally
with their most common utility (`bg-layer-01`, `text-muted`, `rounded-panel`). Do not re-derive a
generic palette.

## Theming

Dark mode lives **inside generated token values** via `light-dark()`; the mode flips via
`color-scheme` on the theme-scope element. The authored theme may preserve different accepted source
palettes per arm—Honk uses ALF light and its Cursor-derived git palette for dark—without exposing
duplicate token names. No theme-switcher machinery or prebuilt per-theme CSS distribution.

- good: `"--honk-color-text-primary": "light-dark(#171717, #f0f0f0)"` +
  `colorScheme: mode === "dark" ? "dark" : "light"` on the scope
- bad: `"--honk-color-text-primary-dark"` as a separate token / `.dark &` descendant selectors /
  a `@media (prefers-color-scheme)` re-declaration block

Because all three layers read the same vars, a `color-scheme` flip re-themes StyleX components,
Tailwind wrappers, and plain-CSS chrome in one move.

Caveat: `light-dark()` is color-only and its two args are top-level comma-delimited, so it cannot
wrap a whole comma-separated value (e.g. a shadow list). Keep one geometry across modes and switch
only the colors inside it: `0 2px 4px light-dark(rgba(0,0,0,.04), rgba(0,0,0,.30))`.

## Never raw values

No raw hex/px/ms outside the token file — in any layer.

| Layer     | bad                                 | good                                           |
| --------- | ----------------------------------- | ---------------------------------------------- |
| StyleX    | `padding: "12px"`                   | `padding: spaceVars["--honk-space-panel-pad"]` |
| Tailwind  | `className="p-[12px] bg-[#161616]"` | `className="p-panel-pad bg-base"`              |
| Plain CSS | `background: #161616;`              | `background: var(--honk-color-bg-base);`       |

Allowed literals at call sites: `0`, `0s`, `100%`, `auto`, `none`, `transparent`, `currentColor`,
`inherit`. Non-tokenized intrinsics (fixed icon geometry, signature animation timing) need a
one-line justification comment.

## Compiler wiring

Three traps; each fails silently or half-works.

1. **StyleX plugin before the React plugin.** `@stylexjs/unplugin` with `useCSSLayers: true`:

```ts
plugins: [stylex.vite({ useCSSLayers: true }), react()],
```

2. **Raw-source packages need `optimizeDeps.exclude`.** A workspace package shipping `.ts` source
   (no pre-compile) must be excluded from Vite's dep optimizer, or esbuild pre-bundles it and skips
   the StyleX transform — **all styles silently vanish**, no error.

```ts
optimizeDeps: { exclude: ["@honk/ui"] },
```

3. **Tailwind v4 plugin runs alongside**, not instead: `@tailwindcss/vite` in the same plugin
   array, with the bridge CSS imported after the token vars are on the page. The bridge is inert
   CSS; there is no ordering coupling with the StyleX plugin itself.
