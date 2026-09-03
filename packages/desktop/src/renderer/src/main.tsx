import "./theme/boot.ts";
import "./theme/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { router } from "./router.tsx";

if (import.meta.env.DEV) {
  void import("react-grab");
}

async function render(): Promise<void> {
  const root = document.getElementById("root");
  if (root === null) throw new Error("Missing #root");

  // Keep the exact static frame in place until TanStack has committed its
  // eager initial route. Later route loads render inside the mounted shell.
  await router.load().catch(() => undefined);
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void render();
