import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** Root for uji's per-user files (auth.json, models-store.json). */
export function defaultUjiHome(): string {
  return process.env["UJI_HOME"] ?? join(homedir(), ".uji");
}
