/**
 * Where the desktop's user-scoped stores live. Trust decisions and the
 * workspace registry sit in `~/.uji` beside the TUI's, so trusting or opening
 * a folder in one client is trusting or opening it in both. Core owns both
 * stores' formats; this file only names the paths.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { WorkspaceRegistry, WorkspaceTrustStore } from "@uji-ai/core";

export function ujiHome(): string {
  return resolve(process.env["UJI_HOME"] ?? join(homedir(), ".uji"));
}

export function createTrustStore(): WorkspaceTrustStore {
  return new WorkspaceTrustStore(join(ujiHome(), "trust.json"));
}

export function createWorkspaceRegistry(): WorkspaceRegistry {
  return new WorkspaceRegistry(join(ujiHome(), "workspaces.json"));
}
