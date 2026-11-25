import { createHash } from "node:crypto";

// Exact-query cache: successful responses, keyed by the Overpass query we actually generate (not
// the raw GPX), kept for as long as this route module lives (until the dev server restarts or
// recompiles it). The same route uploaded twice produces the same query and is answered from
// here instead of hitting the public instance again. Errors are never cached. Capped so a
// long-running server can't grow it without bound; oldest entry goes first.
const RESPONSE_CACHE_MAX_ENTRIES = 200;
export const responseCache = new Map<string, unknown>();

/**
 * Whitespace-normalized query, hashed. The query itself is built deterministically from the
 * chunk's points and radius, so identical input always yields the same key; hashing just keeps
 * keys short instead of holding multi-KB query strings as Map keys.
 */
export function cacheKey(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

export function cacheResponse(key: string, data: unknown): void {
  responseCache.set(key, data);
  if (responseCache.size > RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
}
