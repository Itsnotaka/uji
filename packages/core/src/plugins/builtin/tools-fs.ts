/**
 * The coding tool set as a plugin. `src/tools` is a library of tool
 * implementations; this is the only place that puts them in front of the model.
 */
import { createAllTools, type ToolsOptions } from "../../tools/index.ts";
import { definePlugin } from "../types.ts";

/** Tools that can re-run safely after a crash. Everything else settles as an error on resume. */
const SAFE_REPLAY = new Set(["read", "grep", "find", "ls"]);

export type ToolsFsOptions = ToolsOptions & {
  /** Tool names to leave out. */
  disable?: string[];
};

export function toolsFsPlugin(toolOptions: ToolsFsOptions = {}) {
  return definePlugin({
    id: "tools-fs",
    session(api) {
      const disabled = new Set(toolOptions.disable ?? []);
      const tools = createAllTools(api.env.cwd, toolOptions)
        .filter((tool) => !disabled.has(tool.name))
        .map((tool) => ({
          ...tool,
          replay: SAFE_REPLAY.has(tool.name) ? ("safe" as const) : ("never" as const),
        }));
      api.tools.add((draft) => {
        for (const tool of tools) draft.set(tool.name, tool);
      });
    },
  });
}
