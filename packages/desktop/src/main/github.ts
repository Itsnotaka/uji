/**
 * Optional GitHub enrichment over an existing `gh` installation. The module
 * starts no work until the renderer asks for provider state, and `gh auth
 * login` runs only through the explicit sign-in verb.
 */
import { spawn } from "node:child_process";
import type {
  GitHubAccount,
  GitHubProviderState,
  GitHubPullRequest,
  GitHubPullRequestContext,
  GitHubRepository,
} from "../shared/ipc.ts";

const COMMAND_OUTPUT_LIMIT = 1_000_000;
const DETECTION_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 8_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const STATE_CACHE_MS = 30_000;

export type CommandResult =
  | {
      readonly kind: "completed";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "timeout" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "failed" };

export interface CommandRequest {
  readonly command: "git" | "gh";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

function httpsUrl(value: string, hostname?: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (hostname !== undefined && url.hostname !== hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isMissingCommandError(error: Error): boolean {
  return error.message.includes("ENOENT");
}

export const runProviderCommand: CommandRunner = (request) =>
  new Promise((resolveResult) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > COMMAND_OUTPUT_LIMIT) {
        child.kill();
        finish({ kind: "output_limit" });
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      finish(isMissingCommandError(error) ? { kind: "missing" } : { kind: "failed" });
    });
    child.on("close", (code) => {
      finish({
        kind: "completed",
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "timeout" });
    }, request.timeoutMs);
  });

function repositoryPart(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function repositoryFromParts(
  remoteName: string,
  owner: string | undefined,
  rawName: string | undefined,
): GitHubRepository | undefined {
  if (owner === undefined || rawName === undefined) return undefined;
  const name = rawName.replace(/\.git$/i, "");
  if (!repositoryPart(owner) || !repositoryPart(name)) return undefined;
  return {
    owner,
    name,
    remoteName,
    url: `https://github.com/${owner}/${name}`,
  };
}

/** Parse only repository identity. Userinfo and other raw remote data are discarded. */
export function parseGitHubRemote(
  remoteName: string,
  rawRemote: string,
): GitHubRepository | undefined {
  const remote = rawRemote.trim();
  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)\/?$/i.exec(remote);
  if (scp !== null) return repositoryFromParts(remoteName, scp[1], scp[2]);

  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 2) return undefined;
  return repositoryFromParts(remoteName, segments[0], segments[1]);
}

async function detectRepository(
  cwd: string,
  run: CommandRunner,
): Promise<GitHubRepository | undefined> {
  const remotes = await run({
    command: "git",
    args: ["remote"],
    cwd,
    timeoutMs: DETECTION_TIMEOUT_MS,
  });
  if (remotes.kind !== "completed" || remotes.code !== 0) return undefined;
  const names = remotes.stdout
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .sort((left, right) => {
      const rank = (name: string): number => (name === "origin" ? 0 : name === "upstream" ? 1 : 2);
      return rank(left) - rank(right);
    });
  for (const remoteName of names) {
    const remote = await run({
      command: "git",
      args: ["remote", "get-url", remoteName],
      cwd,
      timeoutMs: DETECTION_TIMEOUT_MS,
    });
    if (remote.kind !== "completed" || remote.code !== 0) continue;
    const repository = parseGitHubRemote(remoteName, remote.stdout);
    if (repository !== undefined) return repository;
  }
  return undefined;
}

function decodeJqTsvField(encoded: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded.charAt(index);
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    switch (encoded.charAt(index)) {
      case "\\":
        decoded += "\\";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      default:
        return undefined;
    }
  }
  return decoded;
}

/** Decode the exact `gh api --jq ... | @tsv` account projection. */
export function decodeGitHubAccountOutput(output: string): GitHubAccount | undefined {
  const line = output.replace(/\r?\n$/u, "");
  if (/[\r\n]/u.test(line)) return undefined;
  const fields = line.split("\t");
  const loginField = fields.at(0);
  const nameField = fields.at(1);
  const avatarField = fields.at(2);
  if (
    fields.length !== 3 ||
    loginField === undefined ||
    nameField === undefined ||
    avatarField === undefined
  ) {
    return undefined;
  }
  const login = decodeJqTsvField(loginField);
  const name = decodeJqTsvField(nameField);
  const avatar = decodeJqTsvField(avatarField);
  if (login === undefined || login === "" || name === undefined || avatar === undefined) {
    return undefined;
  }
  const avatarUrl = avatar === "" ? undefined : httpsUrl(avatar);
  if (avatar !== "" && avatarUrl === undefined) return undefined;
  return {
    login,
    name: name === "" ? undefined : name,
    avatarUrl,
  };
}

/** Decode the exact `gh pr view --jq ... | @tsv` pull-request projection. */
export function decodeGitHubPullRequestOutput(output: string): GitHubPullRequest | undefined {
  const line = output.replace(/\r?\n$/u, "");
  if (/[\r\n]/u.test(line)) return undefined;
  const fields = line.split("\t");
  if (fields.length !== 7) return undefined;
  const numberText = fields.at(0);
  const titleField = fields.at(1);
  const urlField = fields.at(2);
  const state = fields.at(3);
  const draftText = fields.at(4);
  const headField = fields.at(5);
  const baseField = fields.at(6);
  if (
    numberText === undefined ||
    titleField === undefined ||
    urlField === undefined ||
    state === undefined ||
    draftText === undefined ||
    headField === undefined ||
    baseField === undefined
  ) {
    return undefined;
  }
  const title = decodeJqTsvField(titleField);
  const rawUrl = decodeJqTsvField(urlField);
  const headRefName = decodeJqTsvField(headField);
  const baseRefName = decodeJqTsvField(baseField);
  const url = rawUrl === undefined ? undefined : httpsUrl(rawUrl, "github.com");
  if (
    !/^[1-9]\d*$/u.test(numberText) ||
    title === undefined ||
    title === "" ||
    url === undefined ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    (draftText !== "true" && draftText !== "false") ||
    headRefName === undefined ||
    headRefName === "" ||
    baseRefName === undefined ||
    baseRefName === ""
  ) {
    return undefined;
  }
  return {
    number: Number.parseInt(numberText, 10),
    title,
    url,
    state,
    draft: draftText === "true",
    headRefName,
    baseRefName,
  };
}

function commandFailed(result: CommandResult, action: string): string {
  switch (result.kind) {
    case "missing":
      return `${action}: command is not installed`;
    case "timeout":
      return `${action}: command timed out`;
    case "output_limit":
      return `${action}: command returned too much data`;
    case "failed":
      return `${action}: command could not start`;
    case "completed":
      return `${action}: command exited with code ${String(result.code)}`;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

async function accountState(
  cwd: string,
  repository: GitHubRepository,
  run: CommandRunner,
): Promise<GitHubProviderState> {
  const auth = await run({
    command: "gh",
    args: ["auth", "status", "--hostname", "github.com"],
    cwd,
    timeoutMs: DETECTION_TIMEOUT_MS,
  });
  if (auth.kind === "missing") return { kind: "cli_missing", repository };
  if (auth.kind === "completed" && auth.code !== 0) return { kind: "signed_out", repository };
  if (auth.kind !== "completed") {
    return { kind: "error", repository, message: commandFailed(auth, "GitHub authentication") };
  }

  const accountResult = await run({
    command: "gh",
    args: [
      "api",
      "--hostname",
      "github.com",
      "user",
      "--jq",
      '[.login, (.name // ""), (.avatar_url // "")] | @tsv',
    ],
    cwd,
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (accountResult.kind !== "completed" || accountResult.code !== 0) {
    return {
      kind: "error",
      repository,
      message: commandFailed(accountResult, "GitHub account lookup"),
    };
  }
  const account = decodeGitHubAccountOutput(accountResult.stdout);
  if (account === undefined) {
    return { kind: "error", repository, message: "GitHub returned an invalid account response" };
  }

  const pullResult = await run({
    command: "gh",
    args: [
      "pr",
      "view",
      "--repo",
      `${repository.owner}/${repository.name}`,
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName",
      "--jq",
      "[.number, .title, .url, .state, .isDraft, .headRefName, .baseRefName] | @tsv",
    ],
    cwd,
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  let pullRequest: GitHubPullRequestContext;
  if (pullResult.kind === "completed" && pullResult.code === 0) {
    const parsed = decodeGitHubPullRequestOutput(pullResult.stdout);
    pullRequest =
      parsed === undefined
        ? { kind: "error", message: "GitHub returned an invalid pull request response" }
        : { kind: "ready", pullRequest: parsed };
  } else if (
    pullResult.kind === "completed" &&
    (pullResult.stderr.includes("no pull requests found") ||
      pullResult.stderr.includes("Could not resolve to a PullRequest"))
  ) {
    pullRequest = { kind: "none" };
  } else {
    pullRequest = {
      kind: "error",
      message: commandFailed(pullResult, "GitHub pull request lookup"),
    };
  }
  return { kind: "ready", repository, account, pullRequest };
}

export interface GitHubProvider {
  readonly state: (refresh?: boolean) => Promise<GitHubProviderState>;
  readonly signIn: () => Promise<GitHubProviderState>;
  readonly signOut: () => Promise<GitHubProviderState>;
}

export function createGitHubProvider(
  cwd: string,
  run: CommandRunner = runProviderCommand,
): GitHubProvider {
  let cached: { readonly at: number; readonly state: GitHubProviderState } | undefined;
  let inFlight: Promise<GitHubProviderState> | undefined;

  const load = async (): Promise<GitHubProviderState> => {
    const repository = await detectRepository(cwd, run);
    if (repository === undefined) return { kind: "not_github" };
    return accountState(cwd, repository, run);
  };

  const state = (refresh = false): Promise<GitHubProviderState> => {
    if (!refresh && cached !== undefined && Date.now() - cached.at < STATE_CACHE_MS) {
      return Promise.resolve(cached.state);
    }
    if (!refresh && inFlight !== undefined) return inFlight;
    const request = load().then((next) => {
      cached = { at: Date.now(), state: next };
      return next;
    });
    inFlight = request;
    void request.finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    return request;
  };

  return {
    state,
    async signIn() {
      const repository = await detectRepository(cwd, run);
      if (repository === undefined) return { kind: "not_github" };
      const result = await run({
        command: "gh",
        args: [
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--web",
          "--git-protocol",
          "https",
          "--skip-ssh-key",
        ],
        cwd,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
      });
      if (result.kind === "missing") return { kind: "cli_missing", repository };
      if (result.kind !== "completed" || result.code !== 0) {
        return { kind: "error", repository, message: commandFailed(result, "GitHub sign-in") };
      }
      cached = undefined;
      return state(true);
    },
    async signOut() {
      const repository = await detectRepository(cwd, run);
      if (repository === undefined) return { kind: "not_github" };
      const result = await run({
        command: "gh",
        args: ["auth", "logout", "--hostname", "github.com"],
        cwd,
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      if (result.kind === "missing") return { kind: "cli_missing", repository };
      if (result.kind !== "completed" || result.code !== 0) {
        return { kind: "error", repository, message: commandFailed(result, "GitHub sign-out") };
      }
      cached = undefined;
      return state(true);
    },
  };
}
