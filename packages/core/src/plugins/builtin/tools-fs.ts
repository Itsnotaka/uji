/**
 * The coding tool set as a plugin. `src/tools` is a library of tool
 * implementations; this is the only place that puts them in front of the model.
 */
import { createAllTools } from "../../tools/index.ts";
import { definePlugin } from "../types.ts";

/** Tools that can re-run safely after a crash. Everything else settles as an error on resume. */
const SAFE_REPLAY = new Set(["read", "ls"]);

export function toolsFsPlugin() {
  return definePlugin({
    id: "tools-fs",
    session(api) {
      const tools = createAllTools(api.env.cwd).map((tool) => ({
        ...tool,
        replay: SAFE_REPLAY.has(tool.name) ? ("safe" as const) : ("never" as const),
      }));
      api.tools.add((draft) => {
        for (const tool of tools) draft.set(tool.name, tool);
      });
    },
  });
}
