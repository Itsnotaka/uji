import { webcrypto } from "node:crypto";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Generate a PKCE code verifier and S256 challenge (Web Crypto, pi-shaped). */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
