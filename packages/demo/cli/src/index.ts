import process from "node:process";
import { parseCommand, USAGE, UsageError } from "./flags.ts";

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2), process.stdout.isTTY);
  switch (command.kind) {
    case "help":
      console.log(USAGE);
      return;
    case "login": {
      const { runLogin } = await import("./login.ts");
      await runLogin(command);
      return;
    }
    case "logout": {
      const { runLogout } = await import("./login.ts");
      await runLogout(command);
      return;
    }
    case "print": {
      const { runPrint } = await import("./host.ts");
      await runPrint(command);
      return;
    }
    case "chat": {
      const { runTui } = await import("./tui.ts");
      await runTui(command);
      return;
    }
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
