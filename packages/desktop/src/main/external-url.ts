export function safeExternalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  return url.toString();
}
