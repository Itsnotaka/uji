import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "@uji-ai/ui/platform-tokens.css";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) throw new Error("Root element not found");

createRoot(root).render(<App />);
