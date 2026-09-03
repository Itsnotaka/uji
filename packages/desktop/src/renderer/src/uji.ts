/**
 * The renderer's handle on the SDK. `window.uji` is the preload's bridge: the
 * SDK interfaces verbatim, `watch` as a push subscription, plus the host
 * namespace. This client keeps no state beyond query caches and cursors.
 */
import type { UjiBridge } from "../../shared/ipc.ts";

declare global {
  interface Window {
    readonly uji: UjiBridge;
  }
}

export const uji: UjiBridge = window.uji;

export { asSessionId } from "../../shared/ipc.ts";
export type {
  DesktopModelOption,
  DesktopVcsSnapshot,
  GitHubAccount,
  GitHubProviderState,
  GitHubPullRequest,
  GitHubPullRequestContext,
  GitHubRepository,
  HostEvent,
  HostState,
  OpenWorkspaceOutcome,
  ProviderStatus,
  WatchInput,
} from "../../shared/ipc.ts";
