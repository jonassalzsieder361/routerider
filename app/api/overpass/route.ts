import { NextResponse } from "next/server";
import { fetchWaysAlongRoute } from "@/lib/osm/fetchWaysAlongRoute";
import { log, type LatLon } from "@/lib/osm/shared";

// Input validation and HTTP mapping only. Fetching (cache, Overpass failover) lives behind
// fetchWaysAlongRoute in lib/osm/. Response contract for lib/mapMatching.ts is unchanged:
// 200 with Overpass-shaped JSON + X-Overpass-Endpoint header, or 502 with
// { error, upstreamStatus, queryTimedOut }.

// Diagnostic only, investigating why 504s reproduce for manual testing but not for automated
// browser testing against a long-running dev server: timestamps this route module was loaded
// (proxy for "was this just cold-compiled by Next dev, or has it been warm for a while") and
// when it last handled a request, so a cold/idle hit can be told apart from a warm one.
const MODULE_LOADED_AT = Date.now();
let lastRequestAt: number | null = null;

function isValidPoint(p: unknown): p is LatLon {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as LatLon).lat === "number" &&
    typeof (p as LatLon).lon === "number" &&
    Number.isFinite((p as LatLon).lat) &&
    Number.isFinite((p as LatLon).lon)
  );
}

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).slice(2, 8);
  const requestStart = Date.now();

  // Diagnostic only, first thing in the handler (before request.json() or anything else that
  // could itself be delayed) — see MODULE_LOADED_AT comment above.
  const sinceModuleLoadMs = requestStart - MODULE_LOADED_AT;
  const sinceLastRequestMs = lastRequestAt === null ? null : requestStart - lastRequestAt;
  log(
    requestId,
    `handler entered: ${sinceModuleLoadMs}ms since this route module was loaded, ` +
      `${sinceLastRequestMs === null ? "no prior request this module instance" : `${sinceLastRequestMs}ms since last request`}`
  );
  lastRequestAt = requestStart;

  const { points, radiusMeters } = await request.json();

  if (!Array.isArray(points) || points.length === 0 || !points.every(isValidPoint)) {
    return NextResponse.json(
      { error: "points must be a non-empty array of { lat, lon }." },
      { status: 400 }
    );
  }

  if (typeof radiusMeters !== "number" || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return NextResponse.json(
      { error: "radiusMeters must be a positive number." },
      { status: 400 }
    );
  }

  const result = await fetchWaysAlongRoute(points as LatLon[], radiusMeters, requestId, requestStart);

  if (result.ok) {
    return NextResponse.json(result.data, { headers: { "X-Overpass-Endpoint": result.source } });
  }

  return NextResponse.json(
    {
      error: result.error,
      upstreamStatus: result.upstreamStatus,
      // Lets the client halve just this chunk and retry (lib/mapMatching.ts) instead of giving
      // up on the whole route, when the attempt failed on query weight, not on load.
      queryTimedOut: result.queryTimedOut,
    },
    { status: 502 }
  );
}
