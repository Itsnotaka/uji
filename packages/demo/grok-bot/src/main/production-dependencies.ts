import {
  createModels,
  defaultProviderAuthContext,
  FileCredentialStore,
  openaiCodexProvider,
} from "@june/ai";
import type { JuneDesktopEvent } from "../desktop-api.ts";
import type { JuneHostDependencies } from "./june-host.ts";

export function createProductionDependencies(
  openExternal: (url: string) => Promise<unknown>,
): JuneHostDependencies {
  const credentials = new FileCredentialStore();
  const models = createModels({ credentials, authContext: defaultProviderAuthContext() });
  const provider = openaiCodexProvider();
  models.setProvider(provider);
  const model = models.getModel(provider.id, "gpt-5.6-luna");
  if (model === undefined) throw new Error("OpenAI Codex does not expose gpt-5.6-luna");

  return {
    model,
    thinkingLevel: "medium",
    createStreamFn: (sessionId) => (requestedModel, context, options) =>
      models.streamSimple(requestedModel, context, { ...options, sessionId }),
    async authStatus() {
      try {
        const auth = await models.getAuth(provider.id);
        return auth === undefined
          ? { signedIn: false, label: "ChatGPT not connected" }
          : { signedIn: true, label: `ChatGPT connected · ${auth.source ?? "OAuth"}` };
      } catch {
        return { signedIn: false, label: "ChatGPT login expired" };
      }
    },
    async login(emit: (event: JuneDesktopEvent) => void) {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) throw new Error("ChatGPT login is unavailable");

      const controller = new AbortController();
      emit({ type: "status", message: "Opening ChatGPT login…" });
      await models.login(provider.id, "oauth", {
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
    },
  };
}
