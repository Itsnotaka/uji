import { getLLMText, source } from "@/lib/source";

async function everyPage() {
  "use cache";

  const scanned = await Promise.all(source.getPages().map(getLLMText));

  return scanned.join("\n\n");
}

export async function GET() {
  return new Response(await everyPage());
}
