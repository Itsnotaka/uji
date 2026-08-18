# `@june/ui`

Raw-source React primitives for June demos. Base UI owns interaction and accessibility; StyleX owns reusable component styling; each app owns layout, typography, and product identity.

## Add it to a demo

Install `@june/ui` from the workspace and put the StyleX compiler before React:

```ts
import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";

export default {
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  optimizeDeps: { exclude: ["@june/ui"] },
  resolve: { dedupe: ["react", "react-dom"] },
};
```

Apps using the Tailwind-based shadcn components also import `@june/ui/styles.css` once. StyleX-only primitives, such as Avatar, are emitted by the compiler and do not require that stylesheet.

## Theme it

Primitives use inherited `--june-*` custom properties. Override only the tokens that express the app's identity, ideally on the app root so previews can be themed independently:

```css
.my-demo {
  color-scheme: dark;
  --june-color-avatar-orange-background: #5f2a06;
  --june-color-avatar-orange-foreground: #ffb27d;
}
```

Use `className` for consumer layout and `xstyle` when a primitive needs a deliberate visual override. Reuse Base UI parts before creating a new wrapper, and keep domain adapters in the app.
