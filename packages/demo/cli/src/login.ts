/** Interactive credential setup: `uji login` and `uji logout`, on plain stdio. */
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { FileCredentialStore } from "@uji-ai/ai";
import type { AuthEvent, AuthPrompt, AuthType, Models } from "@uji-ai/ai";
import { createCliModels } from "./host.ts";

export interface LoginMethod {
  providerId: string;
  providerName: string;
  type: AuthType;
  /** What the user picks from: "Anthropic — Claude Pro/Max (oauth)". */
  label: string;
}

/** Every provider/auth-method pair with an interactive login. */
export function loginMethods(models: Models): readonly LoginMethod[] {
  const methods: LoginMethod[] = [];
  for (const provider of models.getProviders()) {
    const { oauth, apiKey } = provider.auth;
    if (oauth !== undefined) {
      methods.push({
        providerId: provider.id,
        providerName: provider.name,
        type: "oauth",
        label: `${provider.name} — ${oauth.loginLabel ?? oauth.name}`,
      });
    }
    if (apiKey?.login !== undefined) {
      methods.push({
        providerId: provider.id,
        providerName: provider.name,
        type: "api_key",
        label: `${provider.name} — ${apiKey.name}`,
      });
    }
  }
  return methods;
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed too, so a failed launcher is not fatal.
  }
}

interface Console {
  prompt: (prompt: AuthPrompt) => Promise<string>;
  notify: (event: AuthEvent) => void;
  close: () => void;
}

/** Line-based prompts on stdio. Secrets are read without echo. */
function openConsole(): Console {
  let muted = false;
  const echo = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: echo, terminal: true });

  const ask = async (query: string, secret: boolean, signal?: AbortSignal): Promise<string> => {
    process.stdout.write(query);
    muted = secret;
    try {
      const answer = await rl.question("", { signal: signal ?? new AbortController().signal });
      return answer.trim();
    } finally {
      if (muted) process.stdout.write("\n");
      muted = false;
    }
  };

  return {
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        process.stdout.write(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          process.stdout.write(`  ${index + 1}. ${option.label}\n`);
        });
        const answer = await ask("Choice [1]: ", false, prompt.signal);
        const index = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
        const chosen = prompt.options[index];
        if (chosen === undefined) throw new Error(`Couldn't use ${answer}.`);
        return chosen.id;
      }
      const suffix = prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`;
      return ask(`${prompt.message}${suffix}\n> `, prompt.type === "secret", prompt.signal);
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        process.stdout.write(`${event.instructions ?? "Opening your browser."}\n${event.url}\n`);
        openInBrowser(event.url);
        return;
      }
      if (event.type === "device_code") {
        process.stdout.write(
          `Enter code ${event.userCode} at ${event.verificationUri}\nWaiting for approval…\n`,
        );
        return;
      }
      if (event.type === "info") {
        process.stdout.write(`${event.message}\n`);
        for (const link of event.links ?? []) {
          process.stdout.write(`  ${link.label ?? "link"}: ${link.url}\n`);
        }
        return;
      }
      process.stdout.write(`${event.message}\n`);
    },
    close: () => {
      rl.close();
    },
  };
}

function requireTty(): void {
  if (!process.stdin.isTTY) throw new Error("Login needs a terminal.");
}

async function pick<T>(
  console_: Console,
  message: string,
  items: readonly T[],
  label: (item: T) => string,
): Promise<T> {
  const first = items[0];
  if (first === undefined) throw new Error("Nothing to pick.");
  if (items.length === 1) return first;
  const id = await console_.prompt({
    type: "select",
    message,
    options: items.map((item, index) => ({ id: String(index), label: label(item) })),
  });
  const chosen = items[Number.parseInt(id, 10)];
  if (chosen === undefined) throw new Error("Nothing to pick.");
  return chosen;
}

export async function runLogin(command: { provider?: string }): Promise<void> {
  requireTty();
  const models = createCliModels();
  const all = loginMethods(models);
  const methods =
    command.provider === undefined
      ? all
      : all.filter((method) => method.providerId === command.provider);
  if (methods.length === 0) {
    const known = [...new Set(all.map((method) => method.providerId))].join(", ");
    throw new Error(
      command.provider === undefined
        ? "No provider offers an interactive login."
        : `Couldn't log in to ${command.provider}. Try: ${known}.`,
    );
  }
  const console_ = openConsole();
  try {
    const method = await pick(console_, "Log in to:", methods, (entry) => entry.label);
    await models.login(method.providerId, method.type, {
      prompt: console_.prompt,
      notify: console_.notify,
    });
    const available = await models.getAvailable(method.providerId);
    process.stdout.write(
      `Logged in to ${method.providerName}. ${available.length} models available.\n`,
    );
  } finally {
    console_.close();
  }
}

export async function runLogout(command: { provider?: string }): Promise<void> {
  const credentials = new FileCredentialStore();
  const models = createCliModels(credentials);
  const names = new Map(models.getProviders().map((provider) => [provider.id, provider.name]));
  const stored = await credentials.list();
  const matching =
    command.provider === undefined
      ? stored
      : stored.filter((entry) => entry.providerId === command.provider);
  if (matching.length === 0) {
    process.stdout.write(
      command.provider === undefined
        ? "No stored credential.\n"
        : `No stored credential for ${command.provider}.\n`,
    );
    return;
  }
  const label = (entry: { providerId: string; type: string }): string =>
    `${names.get(entry.providerId) ?? entry.providerId} (${entry.type})`;
  const only = matching[0];
  if (matching.length === 1 && only !== undefined) {
    await models.logout(only.providerId);
    process.stdout.write(`Logged out of ${label(only)}.\n`);
    return;
  }
  requireTty();
  const console_ = openConsole();
  try {
    const chosen = await pick(console_, "Log out of:", matching, label);
    await models.logout(chosen.providerId);
    process.stdout.write(`Logged out of ${label(chosen)}.\n`);
  } finally {
    console_.close();
  }
}
