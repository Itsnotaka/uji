/** Plugins a host builds from values it already has, without a module on disk. */
import type { HarnessTool } from "../harness/agent-harness.ts";
import { definePlugin, type Plugin } from "./types.ts";

/** A plugin that contributes a fixed list of tools. */
export function toolsPlugin(tools: readonly HarnessTool[], id = "tools"): Plugin {
  return definePlugin({
    id,
    session(api) {
      api.tools.add((draft) => {
        for (const tool of tools) draft.set(tool.name, tool);
      });
    },
  });
}
