import process from "node:process";
import { FileCredentialStore } from "@june/ai";
import type { Models } from "@june/ai";
import { createCliModels, DEFAULT_PROVIDER_ID, requireProvider } from "./catalog.ts";
import { cliInteraction } from "./interaction.ts";
import { runPrint } from "./print.ts";
import { parseFlags } from "./run.ts";
import { runTui } from "./tui.ts";

const USAGE = `usage:
  june                          open the full-screen TUI
  june login [provider]         sign in (default: openai-codex)
  june logout [provider]        remove the stored credential
  june status                   list stored credentials
  june -p [--resume] "<prompt>" run one prompt and exit
  flags: --provider <id> · --model <id> · --effort <level>`;

async function login(models: Models, id: string): Promise<void> {
  const provider = requireProvider(models, id);
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
    if (picked !== "oauth" && picked !== "api_key") {
      throw new Error("Invalid login method");
    }
    mode = picked;
  }
  await models.login(provider.id, mode, interaction);
  console.log(`Logged in to ${provider.name}.`);
}

async function main(): Promise<void> {
  const models = createCliModels();
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "login") {
    await login(models, args[1] ?? DEFAULT_PROVIDER_ID);
    return;
  }
  if (command === "logout") {
    const provider = requireProvider(models, args[1] ?? DEFAULT_PROVIDER_ID);
    await models.logout(provider.id);
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
  if (flags.print || (!process.stdout.isTTY && flags.rest.length > 0)) {
    if (flags.rest.length === 0) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    await runPrint(flags);
    return;
  }
  if (!process.stdout.isTTY) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await runTui(flags);
}

await main();
