// The one entry point for OSM way data along a route chunk (Build Guide, "Overpass-Resilienz",
// Stufe 2: providers behind a single interface, as D5 asks for the matching module). Callers get
// Overpass-shaped data and the source that answered, regardless of which provider it was.
//
// Order (decision 2026-11-26): exact-query cache → Postpass (lib/osm/postpassProvider.ts) →
// Overpass endpoints (lib/osm/overpassProvider.ts) as fallback. Postpass gets strictly one
// attempt per request. When it fails, the following requests ask Overpass first for 10 minutes
// ("Overpass preferred"), so a Postpass outage doesn't cost a failed Postpass attempt per chunk;
// in that mode Postpass is the fallback again (one attempt, only after every Overpass endpoint
// failed on load — never after a `remark` query timeout, which goes straight back to the client
// so it halves the chunk), and it goes first anyway if every Overpass endpoint is in cool-down.
// A Postpass success ends the mode early.
import { cacheKey, cacheResponse, responseCache } from "./cache";
import { allOverpassEndpointsCoolingDown, buildOverpassQuery, fetchFromOverpass } from "./overpassProvider";
import { fetchFromPostpass, POSTPASS_ENDPOINT, POSTPASS_SOURCE } from "./postpassProvider";
import { log, type LatLon, type WaysResult } from "./shared";

// "Overpass first" mode after a Postpass failure (in-memory, per server instance).
const OVERPASS_PREFERRED_MS = 10 * 60_000;
let overpassPreferredUntil = 0;

function preferOverpass(requestId: string): void {
  overpassPreferredUntil = Date.now() + OVERPASS_PREFERRED_MS;
  log(requestId, `${POSTPASS_SOURCE} failed, Overpass preferred for the next ${OVERPASS_PREFERRED_MS / 60_000} min`);
}

function endOverpassPreference(requestId: string): void {
  if (overpassPreferredUntil === 0) return;
  overpassPreferredUntil = 0;
  log(requestId, `${POSTPASS_SOURCE} answered again, Overpass preference ended, ${POSTPASS_SOURCE} first again`);
}

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
    log(requestId, `cache hit (key ${key.slice(0, 12)}…, ${responseCache.size} cached queries), no upstream request sent`);
    return { ok: true, data: cached, source: "cache" };
  }

  const finish = (result: WaysResult): WaysResult => {
    if (result.ok) cacheResponse(key, result.data);
    return result;
  };

  if (!POSTPASS_ENDPOINT) return finish(await fetchFromOverpass(requestId, requestStart, query));

  const now = Date.now();
  const overpassPreferred = overpassPreferredUntil > now;
  let postpassError: string | null = null;

  if (!overpassPreferred || allOverpassEndpointsCoolingDown(now)) {
    if (overpassPreferred) log(requestId, `all Overpass endpoints in cool-down, trying ${POSTPASS_SOURCE} first`);
    const viaPostpass = await fetchFromPostpass(requestId, requestStart, points, radiusMeters, 0);
    if (viaPostpass.ok) {
      endOverpassPreference(requestId);
      return finish(viaPostpass);
    }
    postpassError = viaPostpass.error;
    preferOverpass(requestId);
    log(requestId, `falling back to the Overpass endpoints`);
  } else {
    const leftS = Math.round((overpassPreferredUntil - now) / 1000);
    log(requestId, `Overpass preferred (${POSTPASS_SOURCE} failed recently, ${leftS}s left), trying Overpass first`);
  }

  const viaOverpass = await fetchFromOverpass(requestId, requestStart, query);
  if (viaOverpass.ok || viaOverpass.queryTimedOut) return finish(viaOverpass);

  // Every Overpass endpoint failed on load. One Postpass attempt, unless it already failed above.
  if (postpassError === null) {
    log(requestId, `all Overpass endpoints failed on load, trying ${POSTPASS_SOURCE} (one attempt)`);
    const viaPostpass = await fetchFromPostpass(
      requestId,
      requestStart,
      points,
      radiusMeters,
      viaOverpass.failedAttempts ?? 0
    );
    if (viaPostpass.ok) {
      endOverpassPreference(requestId);
      return finish(viaPostpass);
    }
    postpassError = viaPostpass.error;
    preferOverpass(requestId);
  }

  log(requestId, `request failed after ${Date.now() - requestStart}ms total, ${POSTPASS_SOURCE} and Overpass both failed`);
  return {
    ...viaOverpass,
    error: `${postpassError} | Overpass: ${viaOverpass.error}`,
  };
}
