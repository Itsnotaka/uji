import { join } from "node:path";
import process from "node:process";
import { defaultProviders, FileCredentialStore, getProvider, resolveProviderAuth } from "@june/ai";
import type { Provider, ReasoningEffort } from "@june/ai";
import { bashTool, openSession, runAgent } from "@june/core";
import { cliInteraction } from "./interaction.ts";

const SYSTEM =
  "You are june, a minimal coding agent. Work inside the current working directory. " +
  "Use the bash tool to inspect and change files. Be concise.";

const USAGE = `usage:
  june login [provider]     sign in (default: openai-codex)
  june logout [provider]    remove stored credential
  june status               list stored credentials
  june [--resume] [--provider id] [--model id] [--effort level] "<prompt>"`;

interface Flags {
  resume: boolean;
  provider?: string;
  model?: string;
  effort?: string;
  rest: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { resume: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--resume") flags.resume = true;
    else if (arg === "--provider") flags.provider = args[++i];
    else if (arg === "--model") flags.model = args[++i];
    else if (arg === "--effort") flags.effort = args[++i];
    else flags.rest.push(arg);
  }
  return flags;
}

async function login(providers: Provider[], id: string): Promise<void> {
  const provider = getProvider(providers, id);
  const store = new FileCredentialStore();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const interaction = { ...cliInteraction(controller.signal), signal: controller.signal };
  const { oauth, apiKey } = provider.auth;
  let mode: "oauth" | "api_key" = oauth !== undefined ? "oauth" : "api_key";
  if (oauth !== undefined && apiKey?.login !== undefined) {
    const picked = await interaction.prompt({
      type: "select",
      message: `Select ${provider.name} login mode:`,
      options: [
        { id: "oauth", label: oauth.name },
        { id: "api_key", label: apiKey.name },
      ],
    });
    mode = picked as "oauth" | "api_key";
  }
  const credential =
    mode === "oauth" && oauth !== undefined
      ? await oauth.login(interaction)
      : await apiKey?.login?.(interaction);
  if (credential === undefined) throw new Error(`${provider.name} has no interactive login`);
  await store.modify(provider.id, () => Promise.resolve(credential));
  console.log(`Logged in to ${provider.name}.`);
}

async function run(providers: Provider[], flags: Flags): Promise<void> {
  const store = new FileCredentialStore();
  let provider: Provider | undefined;
  let resolved;
  if (flags.provider !== undefined) {
    provider = getProvider(providers, flags.provider);
    resolved = await resolveProviderAuth(provider, store);
  } else {
    for (const candidate of providers) {
      resolved = await resolveProviderAuth(candidate, store);
      if (resolved !== undefined) {
        provider = candidate;
        break;
      }
    }
  }
  if (provider === undefined || resolved === undefined) {
    throw new Error('no provider configured — run "pnpm june login" first');
  }
  const session = openSession({ dir: join(process.cwd(), ".june"), resume: flags.resume });
  session.push({ role: "user", content: flags.rest.join(" ") });
  await runAgent({
    provider,
    auth: resolved.auth,
    model: flags.model ?? process.env["JUNE_MODEL"],
    effort: (flags.effort ?? process.env["JUNE_EFFORT"]) as ReasoningEffort | undefined,
    systemPrompt: SYSTEM,
    tools: [bashTool()],
    session,
    onTextDelta: (text) => process.stdout.write(text),
    onToolCall: (name, args) => {
      const { command } = JSON.parse(args) as { command?: string };
      console.log(name === "bash" ? `\n$ ${command ?? ""}` : `\n[${name}] ${args}`);
    },
  });
  process.stdout.write("\n");
  console.error(`session: ${session.file} (${provider.id}, ${resolved.source ?? "auth"})`);
}

async function main(): Promise<void> {
  const providers = defaultProviders();
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "login") {
    await login(providers, args[1] ?? "openai-codex");
    return;
  }
  if (command === "logout") {
    const provider = getProvider(providers, args[1] ?? "openai-codex");
    await new FileCredentialStore().delete(provider.id);
    console.log(`Logged out of ${provider.name}.`);
    return;
  }
  if (command === "status") {
    const stored = await new FileCredentialStore().list();
    if (stored.length === 0) console.log("no stored credentials");
    for (const info of stored) console.log(`${info.providerId}: ${info.type}`);
    return;
  }
  const flags = parseFlags(args);
  if (flags.rest.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await run(providers, flags);
}

await main();
