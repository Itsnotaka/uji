import process from "node:process";
import { parseFlags, readStdin, resolveTuiResume, USAGE, wantsPrint } from "./flags.ts";
import { VERSION } from "./version.ts";

async function login(id: string | undefined): Promise<void> {
  const { createCliModels, DEFAULT_PROVIDER_ID, loadProviderCatalog, requireProvider } =
    await import("./catalog.ts");
  const { cliInteraction } = await import("./interaction.ts");
  const models = createCliModels();
  const provider = requireProvider(models, id ?? DEFAULT_PROVIDER_ID);
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
  await loadProviderCatalog(models, provider.id);
  console.log(`Logged in to ${provider.name}.`);
}

async function logout(id: string | undefined): Promise<void> {
  const { createCliModels, DEFAULT_PROVIDER_ID, requireProvider } = await import("./catalog.ts");
  const models = createCliModels();
  const provider = requireProvider(models, id ?? DEFAULT_PROVIDER_ID);
  await models.logout(provider.id);
  console.log(`Logged out of ${provider.name}.`);
}

async function status(): Promise<void> {
  const { FileCredentialStore } = await import("@uji-ai/ai");
  const stored = await new FileCredentialStore().list();
  if (stored.length === 0) console.log("no stored credentials");
  for (const info of stored) console.log(`${info.providerId}: ${info.type}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "login") {
    await login(args[1]);
    return;
  }
  if (command === "logout") {
    await logout(args[1]);
    return;
  }
  if (command === "status") {
    await status();
    return;
  }

  const flags = parseFlags(args);
  if (wantsPrint(flags, process.stdout.isTTY === true, process.stdin.isTTY === true)) {
    if (flags.rest.length === 0) {
      const stdin = await readStdin();
      if (stdin === "") {
        console.error(USAGE);
        process.exitCode = 1;
        return;
      }
      flags.rest = [stdin];
    }
    const { runPrint } = await import("./print.ts");
    await runPrint(flags);
    return;
  }
  if (!process.stdout.isTTY) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { runTui } = await import("./interactive.ts");
  const exit = await runTui(resolveTuiResume(flags));
  if (exit.kind === "signal") process.kill(process.pid, exit.signal);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
