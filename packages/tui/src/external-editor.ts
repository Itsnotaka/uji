/**
 * Opens the current draft in a terminal editor and reads it back on exit.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/external-editor.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

type ExternalEditorResult =
  | { status: "completed"; text: string }
  | { status: "failed"; error: Error };

export function resolveExternalEditor(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    configured ?? env["VISUAL"] ?? env["EDITOR"] ?? (platform === "win32" ? "notepad" : "nano")
  );
}

function runEditor(command: string, file: string): Promise<void> {
  const [program, ...args] = command.trim().split(/\s+/u);
  if (program === undefined || program === "") throw new Error("External editor is empty");
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, [...args, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            signal === null
              ? `External editor exited with code ${String(code)}`
              : `External editor exited from ${signal}`,
          ),
        );
      }
    });
  });
}

export async function editInExternalEditor(
  text: string,
  command: string,
): Promise<ExternalEditorResult> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "uji-editor-"));
    const file = join(directory, "draft.md");
    await writeFile(file, text, "utf8");
    await runEditor(command, file);
    const edited = await readFile(file, "utf8");
    return { status: "completed", text: edited.replace(/^\uFEFF/u, "").replace(/\r?\n$/u, "") };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
