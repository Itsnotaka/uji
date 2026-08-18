import { source } from "@/lib/source";
import { llms } from "fumadocs-core/source";

/*
 * `use cache` sits on the data function, not on GET. Under
 * nextConfig.cacheComponents the cached value has to be serialisable, and a
 * Response is not — so the string is cached and the Response is built from it.
 */
async function index() {
  "use cache";

  return llms(source).index();
}

export async function GET() {
  return new Response(await index());
}
