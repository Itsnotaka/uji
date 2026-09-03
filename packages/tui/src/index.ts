import process from "node:process";
import { parseFlags, readStdin, resolveTuiResume, wantsPrint } from "./flags.ts";
import { VERSION } from "./version.ts";
import {
  alignedRows,
  ansiEnabled,
  bold,
  dim,
  renderHelp,
  statusGlyph,
  updateSeverity,
} from "./cli-style.ts";
import type { UpdateProgress } from "./update.ts";

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
  console.log(`${statusGlyph("ok", ansiEnabled())} Logged in to ${provider.name}.`);
  console.log(`  ${dim("run `uji` to start")}`);
}

async function logout(id: string | undefined): Promise<void> {
  const { createCliModels, DEFAULT_PROVIDER_ID, requireProvider } = await import("./catalog.ts");
  const models = createCliModels();
  const provider = requireProvider(models, id ?? DEFAULT_PROVIDER_ID);
  await models.logout(provider.id);
  console.log(`${statusGlyph("ok", ansiEnabled())} Logged out of ${provider.name}.`);
}

async function update(args: readonly string[]): Promise<void> {
  const { checkForUpdate } = await import("./version.ts");
  const { describeUpdateOutcome, selfUpdate } = await import("./update.ts");
  const tty = ansiEnabled();
  if (args.includes("--check")) {
    const notice = await checkForUpdate();
    console.log(
      notice === undefined
        ? `uji ${VERSION} is the latest release.`
        : `Update available: ${notice.version}. Run: uji update`,
    );
    return;
  }
  const version = args.find((arg) => !arg.startsWith("-"));
  console.log(`${bold("uji")} ${dim(`${VERSION} → ${version ?? "latest"}`)}`);

  // On a terminal the percent rows overwrite one line; piped, they stay
  // discrete lines a log can read.
  let progressOpen = false;
  const endProgress = (): void => {
    if (!progressOpen) return;
    process.stdout.write("\n");
    progressOpen = false;
  };
  const report = (event: UpdateProgress): void => {
    switch (event.kind) {
      case "downloading":
        console.log(dim(`downloading ${event.asset}`));
        return;
      case "percent": {
        const row = `  ${String(event.percent)}%`;
        if (!tty) {
          console.log(row);
          return;
        }
        process.stdout.write(`\r\x1b[K${row}`);
        progressOpen = true;
        return;
      }
      case "verified":
        endProgress();
        console.log(`${statusGlyph("ok", tty)} ${dim("checksum verified")}`);
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };
  const outcome = await selfUpdate({
    ...(version === undefined ? {} : { version }),
    report,
  });
  endProgress();

  const severity = updateSeverity(outcome);
  console.log(`${statusGlyph(severity, tty)} ${describeUpdateOutcome(outcome)}`);
  if (severity !== "ok") process.exitCode = 1;
}

async function status(): Promise<void> {
  const { FileCredentialStore } = await import("@uji-ai/ai");
  const stored = await new FileCredentialStore().list();
  if (stored.length === 0) {
    console.log(dim("no stored credentials"));
    return;
  }
  const rows = stored.map((info) => ({ label: info.providerId, detail: info.type }));
  for (const row of alignedRows(rows, ansiEnabled())) console.log(row);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(renderHelp());
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
  if (command === "update") {
    await update(args.slice(1));
    return;
  }

  const flags = parseFlags(args);
  if (wantsPrint(flags, process.stdout.isTTY === true, process.stdin.isTTY === true)) {
    if (flags.rest.length === 0) {
      const stdin = await readStdin();
      if (stdin === "") {
        console.error(renderHelp(false));
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
    console.error(renderHelp(false));
    process.exitCode = 1;
    return;
  }
  const [{ runTui }, { resumeSessionHint }] = await Promise.all([
    import("./interactive.ts"),
    import("./lifecycle.ts"),
  ]);
  const exit = await runTui(resolveTuiResume(flags), {
    onSessionClosed: (sessionId) => {
      process.stdout.write(`${resumeSessionHint(sessionId)}\n`);
    },
  });
  if (exit.kind === "signal") process.kill(process.pid, exit.signal);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const tty = ansiEnabled();
  console.error(tty ? `${statusGlyph("fail", tty)} ${message}` : message);
  process.exitCode = 1;
}
