import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("electron/package.json");
const electronDirectory = dirname(packagePath);
const electronPackage = JSON.parse(readFileSync(packagePath, "utf8"));
const platform = process.env["ELECTRON_INSTALL_PLATFORM"] ?? process.platform;
const executable = executableFor(platform);
const distDirectory = join(electronDirectory, "dist");
const executablePath = join(distDirectory, executable);

if (existsSync(executablePath)) {
  writeFileSync(join(electronDirectory, "path.txt"), executable);
  process.exit(0);
}

let arch = process.env["ELECTRON_INSTALL_ARCH"] ?? process.arch;
if (platform === "darwin" && arch === "x64" && process.env["ELECTRON_INSTALL_ARCH"] === undefined) {
  const translated = spawnSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" });
  if (translated.stdout.trim() === "1") arch = "arm64";
}

process.stdout.write(`Installing Electron ${electronPackage.version} for ${platform}-${arch}…\n`);
const electronRequire = createRequire(packagePath);
const { downloadArtifact } = electronRequire("@electron/get");
const archive = await downloadArtifact({
  version: electronPackage.version,
  artifactName: "electron",
  platform,
  arch,
  checksums: electronRequire("./checksums.json"),
});

const commands =
  process.platform === "win32"
    ? [["tar.exe", ["-xf", archive, "-C", distDirectory]]]
    : [
        ["unzip", ["-q", archive, "-d", distDirectory]],
        ["tar", ["-xf", archive, "-C", distDirectory]],
      ];

let extracted = false;
for (const [command, args] of commands) {
  rmSync(distDirectory, { recursive: true, force: true });
  mkdirSync(distDirectory, { recursive: true });
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) {
    extracted = true;
    break;
  }
}

if (!extracted || !existsSync(executablePath)) {
  throw new Error("Electron downloaded but could not be extracted");
}
if (process.platform !== "win32") chmodSync(executablePath, 0o755);
writeFileSync(join(electronDirectory, "path.txt"), executable);

function executableFor(targetPlatform) {
  switch (targetPlatform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron does not support ${targetPlatform}`);
  }
}
