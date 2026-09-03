/**
 * The GitHub account as the chrome sees it: one variant per thing the rail
 * footer or the Accounts panel has to say. The provider state from main
 * carries repository detail these surfaces never show; this narrows it.
 */
import { useState } from "react";
import type { GitHubAccount, GitHubRepository } from "../../../shared/ipc.ts";
import { signInGitHub, signOutGitHub, useGitHubState } from "../queries.ts";

export type GitHubAccountViewModel =
  | { readonly kind: "loading" }
  | { readonly kind: "no_remote" }
  | { readonly kind: "cli_missing" }
  | {
      readonly kind: "signed_out";
      readonly repository: GitHubRepository;
      readonly signIn: () => void;
    }
  | { readonly kind: "connecting" }
  | {
      readonly kind: "signed_in";
      readonly account: GitHubAccount;
      readonly repository: GitHubRepository;
      readonly signOut: () => void;
      readonly signingOut: boolean;
    }
  | { readonly kind: "error"; readonly message: string };

export function useGitHubAccount(enabled = true): GitHubAccountViewModel {
  const github = useGitHubState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (connecting) return { kind: "connecting" };
  if (github.data === undefined) return { kind: "loading" };

  switch (github.data.kind) {
    case "not_github":
      return { kind: "no_remote" };
    case "cli_missing":
      return { kind: "cli_missing" };
    case "signed_out":
      return {
        kind: "signed_out",
        repository: github.data.repository,
        signIn: () => {
          setConnecting(true);
          void signInGitHub().finally(() => setConnecting(false));
        },
      };
    case "ready":
      return {
        kind: "signed_in",
        account: github.data.account,
        repository: github.data.repository,
        signingOut,
        signOut: () => {
          setSigningOut(true);
          void signOutGitHub().finally(() => setSigningOut(false));
        },
      };
    case "error":
      return { kind: "error", message: github.data.message };
    default: {
      const _exhaustive: never = github.data;
      return _exhaustive;
    }
  }
}
