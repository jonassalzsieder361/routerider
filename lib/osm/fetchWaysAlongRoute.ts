// The one entry point for OSM way data along a route chunk (Build Guide, "Overpass-Resilienz",
// Stufe 2: providers behind a single interface, as D5 asks for the matching module). Callers get
// Overpass-shaped data and the source that answered, regardless of which provider it was.
// Order: exact-query cache → Overpass endpoints (lib/osm/overpassProvider.ts).
import { cacheKey, cacheResponse, responseCache } from "./cache";
import { buildOverpassQuery, fetchFromOverpass } from "./overpassProvider";
import { log, type LatLon, type WaysResult } from "./shared";

export async function fetchWaysAlongRoute(
  points: LatLon[],
  radiusMeters: number,
  requestId: string,
  requestStart: number = Date.now()
): Promise<WaysResult> {
  const query = buildOverpassQuery(points, radiusMeters);

  log(
    requestId,
    `new request: ${points.length} points, radius=${radiusMeters}m, query length=${query.length} chars`
  );

  // The cache key stays derived from the generated Overpass query, independent of which
  // provider/endpoint answers (Build Guide, "Cache bleibt endpoint-unabhängig").
  const key = cacheKey(query);
  const cached = responseCache.get(key);
  if (cached !== undefined) {
    log(requestId, `cache hit (key ${key.slice(0, 12)}…, ${responseCache.size} cached queries), no Overpass request sent`);
    return { ok: true, data: cached, source: "cache" };
  }

  const result = await fetchFromOverpass(requestId, requestStart, query);
  if (result.ok) cacheResponse(key, result.data);
  return result;
}
