---
name: stylex
description: Author StyleX styles — token-driven, CSS-native, compile-time checked
---

# StyleX

Agent guidance for writing StyleX. Derived from [facebook/astryx](https://github.com/facebook/astryx)
(`CLAUDE.md` STYLEX-CAPS block, `internal/stylex-capabilities/CAPABILITIES.md`, `packages/cli/docs/styling.doc.mjs`).
Every rule is diff-checkable.

## Source of truth

1. **Installed typings** — probe `node_modules/@stylexjs/stylex/lib/es/stylex.d.ts` (and
   `lib/es/types/StyleXTypes.d.ts`) before claiming an API exists. In pnpm workspaces, resolve through
   the package that depends on StyleX, not necessarily the repo root. Never trust a capability from
   memory or from a different StyleX version.
2. **Capability scan** — astryx compiles snippets with `internal/stylex-capabilities/scan.mjs` and
   publishes `CAPABILITIES.md`. Re-run or compile a minimal snippet when unsure. Prose is not proof.
3. **Nearby code** — copy shape from existing `*.stylex.ts` files and `stylex.create()` blocks in the
   project before inventing patterns.

## Capability matrix (STYLEX-CAPS)

Prefer CSS-native solutions. Do not hand-roll JS for a supported feature.

```
[StyleX CSS support]|Probe installed version; astryx 0.17.5 scan is a reference, not gospel for your pin.
|AT-RULES: @media, @supports, @container (+named), @starting-style, @scope — verify on your pin
|AT-RULES: @layer, @property (explicit) — invalid output; unplugin may own @layer via useCSSLayers
|PSEUDO-CLS: :hover, :focus, :focus-visible, :focus-within, :active, :disabled — on self
|PSEUDO-CLS: :first-child, :last-child, :nth-child(), :where(), :is(), :has(), :not() — on self
|PSEUDO-CLS: :placeholder-shown, :checked, :empty, :modal, :user-valid, :user-invalid — on self
|PSEUDO-EL: ::before, ::after, ::placeholder, ::selection, ::backdrop, ::marker, ::view-transition-* — on self
|COMPOUND: ::backdrop+condition, RTL :is([dir="rtl"] *), nested @media+pseudo — on self
|VALUES: var(), calc(), clamp(), light-dark(), color-mix(), container-type/name — pass through
|ANIM: transition (shorthand+individual), transitionBehavior:allow-discrete, animation, stylex.keyframes
|WHEN: stylex.when.ancestor(':hover'/':focus-within'/':active'/':disabled') — cross-element
|WHEN: stylex.when.descendant(':hover'), siblingBefore(':checked'), siblingAfter(':checked'), anySibling(':hover')
|WHEN: stylex.when.ancestor('[data-attr]') — NO on astryx 0.17.5 (pseudo selectors only, must start with ":")
|NESTING: CSS nesting with & — NO (use stylex.when.* or on-self patterns)
|API: stylex.firstThatWorks() — CSS fallbacks (e.g. display: grid with flex fallback)
|API: stylex.positionTry() — anchor positioning @position-try
|API: stylex.defineConsts(), stylex.types.* — verify on your pin
|DYNAMIC: Functions in stylex.create for runtime values — YES (emits CSS var + @property)
|VARS: stylex.defineVars, stylex.createTheme — require .stylex.ts files; verify runtime setup
|LAYOUT: grid, flex+gap, aspect-ratio, overscrollBehavior, scrollbar-gutter/width
|PATTERN: dialog entry animation -> @starting-style (not useState+rAF)
|PATTERN: parent hover -> child style -> stylex.when.ancestor(':hover', marker) (see §5)
|PATTERN: hover on touch -> @media (hover: hover) guard nested inside :hover
|PATTERN: zebra striping -> :nth-child(even) (not index%2 JS)
|PATTERN: container responsive -> @container (not ResizeObserver) — verify on your pin
|PATTERN: CSS fallback values -> stylex.firstThatWorks() (not manual fallback)
|PATTERN: dynamic/runtime values -> stylex.create({ s: (v) => ({ prop: v }) }) (not inline style=)
|PATTERN: conditional styles -> stylex.props(cond && styles.x) (not className toggling)
|BANNED: hand-authored @layer / @property when unplugin owns layers; className/style escape hatches in StyleX-only codebases
|VERIFY: compile a snippet or run astryx scan.mjs
```

## Tokens

1. **One `stylex.defineVars` per concern** over a plain `*Defaults` object exported alongside it, plus a
   `*VarName` key-union type (`keyof typeof colorDefaults`). A cross-platform project may author
   renderer-neutral values elsewhere and generate these blocks; in Honk, edit `theme.ts` and run the
   token synchronizer instead of editing `platform-tokens.stylex.ts`. No raw color/spacing literals
   at call sites.
   - good: `export const colorDefaults = { "--color-text-primary": "…" } as const; export const colorVars = stylex.defineVars(colorDefaults); export type ColorVarName = keyof typeof colorDefaults;`
   - bad: a second `defineVars` in a component file, or `"#fff"` / `"12px"` at a call site.
2. **Var keys are literal CSS custom-property names**, read by bracket: `gap: spaceVars["--spacing-4"]`.
   JS name == CSS output == one vocabulary.
   - good: `paddingInline: spaceVars["--spacing-panel-pad"]`
   - bad: `paddingInline: spaceVars.panelPad` / `paddingInline: "12px"`
3. **Semantic tokens, not hardcoded values.** Swap token _values_ in the token file; call sites reference
   keys only. Allowed literals at call sites: `0`, `0s`, `100%`, `auto`, `none`, `transparent`,
   `currentColor`, `inherit`. Non-tokenized intrinsics (fixed icon geometry, signature animation timing)
   need a one-line justification comment.

## Themes

Two common mechanisms (use what the project already has):

1. **`light-dark()` inside token values; mode via `color-scheme` on the theme scope** — not a duplicate
   token set per mode.
   - good: `"--color-text-primary": "light-dark(#171717, #f0f0f0)"` + `colorScheme: mode === "dark" ? "dark" : "light"`
   - bad: `"--color-text-primary-dark"` as a separate token / `.dark &` descendant selector.
2. **`stylex.createTheme` objects over a `surfaceVars` map**, selected in app code and spread onto a scope
   element with `stylex.props`. Use for surface/vibrancy/contrast swaps that affect a subtree.
   - good: `stylex.props(rootStyles.surface, surfaceTheme)`
   - bad: `body[data-glass] .bubble { … }` in plain CSS to react to a mode the component tree owns.

astryx also ships `defineTheme` / `[data-astryx-theme]` — follow that when working inside astryx; otherwise
`createTheme` + `color-scheme` is the portable pattern.

## `create()` authoring rules

`xstyle` is the caller's style-override prop (astryx convention). Adapt the name to the project.

1. **Multiple named `create()` per concern**, never one mega-object: `styles`, `variants`, `sizeStyles`,
   `stateStyles`. Derive types: `type Size = keyof typeof sizeStyles`.
2. **Merge order (last wins):** base → variant → size → boolean-state → caller `xstyle` last.
   - good: `stylex.props(styles.base, variants[variant], sizeStyles[size], isDisabled && styles.disabled, xstyle)`
   - bad: `xstyle` before variant, or two `stylex.props()` calls concatenated.
3. **Conditionals are `cond && styles.x` inside `stylex.props`**, never className toggling.
4. **Border longhands only** (`borderWidth` / `borderStyle` / `borderColor`); `border: "none"` allowed
   for reset only.
   - bad: `border: "1px solid #ccc"` → good: longhands + `colorVars["--color-border"]`
5. **No all-null overrides** (defeats the atomic-CSS inliner). `{default: null, ':hover': value}` is
   fine; `{default: null, ':active': null}` must become a concrete value.
   - bad: `transform: { default: null, ":active": null }` → good: `transform: "none"`
6. **Every `:hover` nests `@media (hover: hover)`** (kills sticky-hover on touch). `:active` and
   `:focus-visible` are not guarded.
   - good: `backgroundColor: { default: base, ":hover": { "@media (hover: hover)": hovered } }`
7. **Every transition/animation carries `@media (prefers-reduced-motion: reduce) → 0s`** (or `none` for
   `animationName`). Pair JS `matchMedia` stores with CSS siblings for SSR first-paint safety.
8. **Boolean props are `is*` / `has*`.** `isDisabled`, `hasError` — not `disabled`, `error`.
9. **Condition ordering inside a value:** `default` first, then pseudo/attr, with `@media` nested inside
   the pseudo.

## Parent-state patterns

### Primary (astryx): `stylex.when.ancestor` + scoped markers

Parent hover/focus-within/active state that should style a child:

1. Define a scoped marker in a `*.markers.stylex.ts` file: `export const tabScope = stylex.defineMarker();`
2. Put `tabScope.marker` on the **ancestor's** `stylex.props()` call.
3. Reference in the child's `create()` block:
   `[stylex.when.ancestor(':hover', tabScope)]: { '@media (hover: hover)': value }`
4. **Never use `stylex.defaultMarker()` for form controls** (Checkbox, Radio, Switch) — it leaks
   hover/focus-within from outer containers like Popovers. Always use a component-scoped `defineMarker()`.

### Alternatives when cross-element selectors are unavailable or banned

Some codebases (StyleX pins, lint rules, or SSR constraints) forbid `when.ancestor`. Substitutes:

1. **Private `--_var` on the parent, read by the child.** Parent sets under its own `:hover`; child reads
   `var(--_reveal, 0)`. `--_` prefix = private, never themed.
2. **Passive `data-*` on a child + `:has()` on the container** (on-self pseudo on the container).
3. **JS-resolved style pick** — context, measurement, or `matchMedia` store chooses a style object.
   First/last rounding uses `:first-child` / `:last-child` on self, not parent descendant rules.

## Dynamic values and keyframes

1. **Runtime values via a function in `create()`, never inline `style=`.** StyleX emits a CSS var.
   - good: `const dyn = stylex.create({ w: (px: string) => ({ width: px }) }); stylex.props(dyn.w(width))`
   - bad: `<div style={{ width }} />`
2. **Keyframes are module-level `stylex.keyframes(...)`** beside the `create()` that uses them.
   Durations/easings from motion tokens. Shared animations get a `*.stylex.ts` module.
3. **Entry/exit transitions:** prefer `@starting-style` or headless transition `data-starting-style` /
   `data-ending-style` attribute conditions on self — not `useEffect` + `requestAnimationFrame`.

## Applying styles

- **Components:** use the project's narrow override prop. In Honk this is the typed
  React-Native-shaped `style` boundary merged through `applyStyle`; app call sites may use it for
  composition only, never to repaint canonical control chrome.
- **DOM elements:** `{...stylex.props(styles.base, cond && styles.active)}` — spread `className` and
  `style` together; do not split across two calls.
- **In StyleX-only codebases:** no `className` / `style` escape hatches on styled elements. In mixed
  codebases (astryx + Tailwind), `className` is for layout wrappers; component overrides prefer `xstyle`.

## Build wiring

Raw-source packages that ship `.ts` without a pre-compile step require the consumer to run
`@stylexjs/unplugin` (or the babel plugin) **before** the React plugin, with `useCSSLayers: true` when
the project uses CSS layers. Add the raw-source package to `optimizeDeps.exclude` in Vite — forgetting
it lets esbuild pre-bundle the source, **skipping the StyleX transform; all styles silently vanish**.

`defineVars` / `createTheme` in `.stylex.ts` files must not execute at runtime in the browser bundle;
ensure the babel/unplugin pipeline processes those files.

## Project overrides

Read the repo's ADRs, lint config, and existing `*.stylex.ts` files before writing. A project picks
one of two `className` stances:

- **StyleX-only** — no `className` / `style` escape hatches on styled elements; StyleX per element.
- **Layered (honk's model, see the styling-tokens skill)** — StyleX owns component primitives;
  token-backed Tailwind utilities are the sanctioned layout/wrapper channel (a pure-CSS
  `@theme inline` bridge aliases utility names to the same token vars); plain CSS + `var()` covers
  roots and chrome. Third-party DOM adapters use colocated CSS modules + token vars. `className`
  carries layout utilities only, and Tailwind arbitrary values with raw hex/px are banned.

A project may also:

- Ban `stylex.when.ancestor` (on-self only) — use §5 alternatives.
- Pin a specific StyleX version — re-verify STYLEX-CAPS against that pin's typings.
- Require effect-free components — drive animation/visual state from CSS and external stores, not
  `useEffect`.

When project rules conflict with astryx defaults, **project rules win**.
