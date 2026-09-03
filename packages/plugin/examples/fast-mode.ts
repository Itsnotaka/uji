/**
 * Fast inference as session policy. A host supplies its selected model, then
 * the plugin contributes `/fast`, a fast-mode setting, and patches assistant
 * requests while enabled. Nothing is contributed for a model that does not
 * advertise the mode, so the command and setting exist only where they can
 * run. The value lives in plugin storage only; every read goes there, so a
 * fresh host sees the same state the last one wrote. The setting declares that
 * storage key, so any host resolves and moves the value.
 */
import { definePlugin } from "@uji-ai/plugin";
import type { Api, JsonValue, Model } from "@uji-ai/schema";

export const FAST_MODE_PLUGIN_ID = "fast-mode";

interface SessionFacts {
  getFact(fact: string): Promise<JsonValue | undefined>;
}

/**
 * Fast inference bills at a premium and every provider prices it differently,
 * so a selection belongs to the provider it was made for, not to the session.
 */
function enabledKey(model: Model<Api>): string {
  return `enabled:${model.provider}`;
}

function supportsFastMode(model: Model<Api>): boolean {
  return model.modes?.includes("fast") ?? false;
}

export async function readFastMode(session: SessionFacts, model: Model<Api>): Promise<boolean> {
  if (!supportsFastMode(model)) return false;
  const fact = await session.getFact(`plugin:${FAST_MODE_PLUGIN_ID}:${enabledKey(model)}`);
  return fact === "on";
}

export function fastModePlugin(model: Model<Api>) {
  return definePlugin({
    id: FAST_MODE_PLUGIN_ID,
    session(api) {
      if (!supportsFastMode(model)) return;
      const key = enabledKey(model);
      const read = async (): Promise<boolean> => (await api.storage.get(key)) === "on";
      const write = (enabled: boolean): Promise<void> =>
        api.storage.set(key, enabled ? "on" : "off");

      // The setting declares `key`; the harness reads and writes it, so the
      // settings menu and `/fast` below move the same durable fact.
      api.settings.add((settings) =>
        settings.set("fast", {
          label: "Fast mode",
          key,
          fallback: "off",
          choices: [
            {
              id: "on",
              label: "on",
              description: "Priority processing at a premium",
              status: "fast",
            },
            { id: "off", label: "off", description: "Standard processing" },
          ],
        }),
      );

      api.commands.add((commands) =>
        commands.set("fast", {
          description: "Toggle fast inference",
          run: async (argument) => {
            if (argument !== "") throw new Error("/fast takes no argument");
            const enabled = !(await read());
            await write(enabled);
            return `Fast mode: ${enabled ? "on" : "off"}`;
          },
        }),
      );

      api.hook("before_request", async (event) => {
        if (event.step !== "assistant") return undefined;
        return (await read()) ? { streamOptions: { fast: true } } : undefined;
      });
    },
  });
}
