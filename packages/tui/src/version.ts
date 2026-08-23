/** Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/version-check.ts */
import process from "node:process";
import { gt, valid } from "semver";
import packageMetadata from "../package.json" with { type: "json" };

const LATEST_RELEASE_URL = "https://api.github.com/repos/Itsnotaka/uji/releases/latest";
const RELEASES_URL = "https://github.com/Itsnotaka/uji/releases/latest";

export const VERSION = packageMetadata.version;

export interface UpdateNotice {
  version: string;
  url: string;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = valid(candidate.trim());
  const currentVersion = valid(current.trim());
  return (
    candidateVersion !== null && currentVersion !== null && gt(candidateVersion, currentVersion)
  );
}

export async function checkForUpdate(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<UpdateNotice | undefined> {
  if (process.env.UJI_OFFLINE !== undefined || process.env.UJI_SKIP_VERSION_CHECK !== undefined) {
    return undefined;
  }
  try {
    const response = await fetchFn(LATEST_RELEASE_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "User-Agent": `uji/${VERSION}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("tag_name" in data) ||
      typeof data.tag_name !== "string"
    ) {
      return undefined;
    }
    const version = valid(data.tag_name.trim().replace(/^v/u, ""));
    if (version === null || !isNewerVersion(version, VERSION)) return undefined;
    const url =
      "html_url" in data &&
      typeof data.html_url === "string" &&
      data.html_url.startsWith("https://github.com/Itsnotaka/uji/releases/")
        ? data.html_url
        : RELEASES_URL;
    return { version, url };
  } catch {
    return undefined;
  }
}
