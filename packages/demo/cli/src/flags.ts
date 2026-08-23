export const USAGE = `usage:
  uji                          open the TUI
  uji -p "<prompt>"            run one prompt and exit
  uji -p --resume "<prompt>"   continue the newest session
  uji login [provider]         sign in to a provider
  uji logout [provider]        remove a stored credential`;

export class UsageError extends Error {
  readonly _tag = "UsageError";
  constructor() {
    super(USAGE);
    this.name = "UsageError";
  }
}

export type Command =
  | { kind: "help" }
  | { kind: "login"; provider?: string }
  | { kind: "logout"; provider?: string }
  | { kind: "print"; resume: boolean; prompt: string }
  | { kind: "chat"; resume: boolean };

export function parseCommand(args: readonly string[], tty: boolean): Command {
  let resume = false;
  let print = false;
  let help = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h" || arg === "help") help = true;
    else if (arg === "--resume" || arg === "-c") resume = true;
    else if (arg === "--print" || arg === "-p") print = true;
    else if (arg.startsWith("-")) throw new Error(`Couldn't use ${arg}.`);
    else rest.push(arg);
  }
  if (help) return { kind: "help" };
  const [first, ...arguments_] = rest;
  if (first === "login" || first === "logout") {
    if (arguments_.length > 1) throw new UsageError();
    const provider = arguments_[0];
    return provider === undefined ? { kind: first } : { kind: first, provider };
  }
  const prompt = rest.join(" ");
  if (print || (!tty && prompt !== "")) {
    if (prompt === "") throw new UsageError();
    return { kind: "print", resume, prompt };
  }
  if (!tty) throw new UsageError();
  return { kind: "chat", resume };
}
