import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@uji-ai/ai";
import type { Provider } from "@uji-ai/ai";
import { loginMethods } from "../src/login.ts";

function provider(id: string, auth: Provider["auth"]): Provider {
  return {
    id,
    name: id.toUpperCase(),
    auth,
    getModels: () => [],
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
}

void test("loginMethods lists every interactive method, oauth first", () => {
  const models = createModels();
  models.setProvider(
    provider("both", {
      oauth: {
        name: "Both OAuth",
        loginLabel: "Sign in with Both",
        login: () => Promise.reject(new Error("not used")),
        refresh: () => Promise.reject(new Error("not used")),
        toAuth: () => Promise.resolve({}),
      },
      apiKey: {
        name: "Both API key",
        login: () => Promise.resolve({ type: "api_key", key: "k" }),
        resolve: () => Promise.resolve(undefined),
      },
    }),
  );
  models.setProvider(
    provider("ambient", { apiKey: { name: "Ambient", resolve: () => Promise.resolve(undefined) } }),
  );

  assert.deepEqual(loginMethods(models), [
    { providerId: "both", providerName: "BOTH", type: "oauth", label: "BOTH — Sign in with Both" },
    { providerId: "both", providerName: "BOTH", type: "api_key", label: "BOTH — Both API key" },
  ]);
});
