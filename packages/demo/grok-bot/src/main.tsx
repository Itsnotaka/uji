import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { registerJuneEvents } from "./june-view.ts";
import { applyThemePreference, loadThemePreference } from "./theme.ts";
import "./styles.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Root element not found");
}

applyThemePreference(loadThemePreference());

const queryClient = new QueryClient();
registerJuneEvents(queryClient);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
