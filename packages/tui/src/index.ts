import process from "node:process";
import { parseFlags, readStdin, resolveTuiResume, wantsPrint } from "./flags.ts";
import { VERSION } from "./version.ts";
import { GLYPHS } from "./constants.ts";
import {
  dim,
  fieldRow,
  green,
  isPercentLine,
  red,
  renderHelp,
  statusGlyph,
  columnWidth,
  ansiEnabled,
  bold,
} from "./cli-style.ts";

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
  console.log(`${green(GLYPHS.check)} Logged in to ${provider.name}.`);
  console.log(`  ${dim("run `uji` to start")}`);
}

async function logout(id: string | undefined): Promise<void> {
  const { createCliModels, DEFAULT_PROVIDER_ID, requireProvider } = await import("./catalog.ts");
  const models = createCliModels();
  const provider = requireProvider(models, id ?? DEFAULT_PROVIDER_ID);
  await models.logout(provider.id);
  console.log(`${green(GLYPHS.check)} Logged out of ${provider.name}.`);
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

  // Percent lines collapse into one rewritten row on a terminal; elsewhere
  // they stay discrete lines a log can read.
  let progressOpen = false;
  const report = (line: string): void => {
    if (isPercentLine(line)) {
      const percent = line.trim();
      if (tty) {
        process.stdout.write(`\r\x1b[K  ${percent}`);
        progressOpen = true;
      } else {
        console.log(`  ${percent}`);
      }
      return;
    }
    if (progressOpen && tty) {
      process.stdout.write("\n");
      progressOpen = false;
    }
    if (/^Checksum ok\.?$/u.test(line)) {
      console.log(`${statusGlyph("ok", tty)} ${dim(line)}`);
      return;
    }
    console.log(tty ? dim(line) : line);
  };
  const outcome = await selfUpdate({
    ...(version === undefined ? {} : { version }),
    report,
  });
  if (progressOpen && tty) process.stdout.write("\n");

  const message = describeUpdateOutcome(outcome);
  const glyph =
    outcome.kind === "updated" || outcome.kind === "current"
      ? statusGlyph("ok", tty)
      : outcome.kind === "unsupported"
        ? statusGlyph("warn", tty)
        : statusGlyph("fail", tty);
  console.log(`${glyph} ${message}`);
  if (outcome.kind === "failed" || outcome.kind === "unsupported") process.exitCode = 1;
}

async function status(): Promise<void> {
  const { FileCredentialStore } = await import("@uji-ai/ai");
  const stored = await new FileCredentialStore().list();
  if (stored.length === 0) {
    console.log(dim("no stored credentials"));
    return;
  }
  const width = columnWidth(stored.map((info) => info.providerId));
  for (const info of stored) {
    console.log(fieldRow(info.providerId, info.type, width, ansiEnabled()));
  }
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
  const { runTui } = await import("./interactive.ts");
  const exit = await runTui(resolveTuiResume(flags));
  if (exit.kind === "signal") process.kill(process.pid, exit.signal);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(ansiEnabled() ? `${red(GLYPHS.cross)} ${message}` : message);
  process.exitCode = 1;
}
