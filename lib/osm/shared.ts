// Shared by the OSM data providers (server-side only; used from app/api/overpass/route.ts).

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Outcome of fetching the ways along one chunk. `data` is always in Overpass `out geom` shape
 * ({ elements: [{ type: "way", id, tags, geometry: [{ lat, lon }] }] }), whichever provider
 * answered, so lib/mapMatching.ts doesn't need to know where it came from.
 */
export type WaysResult =
  | {
      ok: true;
      data: unknown;
      /** Who answered: the provider's host, or "cache". Sent as X-Overpass-Endpoint. */
      source: string;
    }
  | {
      ok: false;
      error: string;
      upstreamStatus: number;
      /** Query too heavy (Overpass `remark`): the client halves this chunk (lib/mapMatching.ts). */
      queryTimedOut: boolean;
      /** How many attempts failed (for the next provider's log line). */
      failedAttempts?: number;
    };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(requestId: string, message: string): void {
  console.log(`[overpass ${requestId}] ${new Date().toISOString()} ${message}`);
}

export function endpointHost(url: string): string {
  return new URL(url).hostname;
}

// Tags passed on to the client — what D7 surface inference and matching need (Build Guide,
// Phase 3, "Finale v0.1-Spezifikation"). Overpass's `out geom` always returns every tag, so the
// rest is dropped here, before caching and sending. Which *ways* are fetched is unaffected: the
// query still selects every way[highway], without excluding any highway value.
const RELEVANT_TAGS = [
  "highway",
  "surface",
  "tracktype",
  "smoothness",
  "bicycle",
  "cycleway",
  "mtb:scale",
];

export function keepRelevantTags(data: unknown): unknown {
  const elements = (data as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return data;

  return {
    ...(data as object),
    elements: elements.map((el: { tags?: Record<string, string> }) => {
      if (!el.tags) return el;
      const tags: Record<string, string> = {};
      for (const key of RELEVANT_TAGS) {
        if (key in el.tags) tags[key] = el.tags[key];
      }
      return { ...el, tags };
    }),
  };
}
