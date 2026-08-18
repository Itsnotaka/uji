import { FileCredentialStore, defaultProviders, getProvider, resolveProviderAuth } from "@june/ai";
import { createProviderStreamFn } from "@june/core";
import type { JuneDesktopEvent } from "../desktop-api.ts";
import type { JuneHostDependencies } from "./june-host.ts";

export function createProductionDependencies(
  openExternal: (url: string) => Promise<unknown>,
): JuneHostDependencies {
  const provider = getProvider(defaultProviders(), "openai-codex");
  const credentials = new FileCredentialStore();

  return {
    model: provider.defaultModel,
    thinkingLevel: provider.defaultEffort,
    createStreamFn: (sessionId) =>
      createProviderStreamFn({
        provider,
        auth: { store: credentials },
        sessionId,
      }),
    async authStatus() {
      try {
        const auth = await resolveProviderAuth(provider, credentials);
        return auth === undefined
          ? { signedIn: false, label: "ChatGPT not connected" }
          : { signedIn: true, label: `ChatGPT connected · ${auth.source}` };
      } catch {
        return { signedIn: false, label: "ChatGPT login expired" };
      }
    },
    async login(emit: (event: JuneDesktopEvent) => void) {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) throw new Error("ChatGPT login is unavailable");

      const controller = new AbortController();
      emit({ type: "status", message: "Opening ChatGPT login…" });
      const credential = await oauth.login({
        signal: controller.signal,
        prompt: (prompt) => {
          if (prompt.type === "select") return Promise.resolve("browser");
          if (prompt.type === "manual_code") {
            return new Promise<string>((_resolve, reject) => {
              const cancel = (): void => reject(new Error("Browser login finished"));
              if (prompt.signal?.aborted === true) cancel();
              else prompt.signal?.addEventListener("abort", cancel, { once: true });
            });
          }
          return Promise.reject(new Error("This login step is not supported in the desktop app"));
        },
        notify: (event) => {
          if (event.type === "auth_url") void openExternal(event.url);
          if (event.type === "progress" || event.type === "info") {
            emit({ type: "status", message: event.message });
          }
        },
      });
      await credentials.modify(provider.id, () => Promise.resolve(credential));
    },
  };
}
