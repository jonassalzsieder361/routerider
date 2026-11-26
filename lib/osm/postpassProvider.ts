// Postpass provider (Build Guide, "Overpass-Resilienz", Stufe 2): Geofabrik's public PostGIS
// instance of OSM data, queried with SQL instead of Overpass QL. Primary source since 2026-11-26,
// with the Overpass endpoints as fallback (lib/osm/fetchWaysAlongRoute.ts). Strictly one attempt
// per request, no retry, no SLA.
import { keepRelevantTags, log, type LatLon, type WaysResult } from "./shared";

// POST, form field `data` (confirmed 2026-11-25; the versioned /api/0.2/interpreter path only
// answers with a 308 to this one). Overridable via POSTPASS_ENDPOINT; set it to an empty value to
// switch Postpass off (then only Overpass is used). Rate limits/timeouts are not documented and are only clarified by
// observing logs and error codes in operation (Build Guide decision 2026-11-25).
const DEFAULT_POSTPASS_ENDPOINT = "https://postpass.geofabrik.de/api/interpreter";

export const POSTPASS_ENDPOINT: string | null = (() => {
  const raw = process.env.POSTPASS_ENDPOINT;
  if (raw === undefined) return DEFAULT_POSTPASS_ENDPOINT;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // fall through
  }
  console.log(`[overpass] POSTPASS_ENDPOINT: ignoring invalid URL "${raw}", Postpass fallback disabled`);
  return null;
})();
console.log(`[overpass] postpass (primary source): ${POSTPASS_ENDPOINT ?? "disabled, Overpass only"}`);

// Same budget as one Overpass attempt.
const REQUEST_TIMEOUT_MS = 45000;

/** Source label for logs and the X-Overpass-Endpoint header. */
export const POSTPASS_SOURCE = "postpass";

// ---------------------------------------------------------------------------------------------
// Query

/** Same 7 tags as the shared tag filter; selected server-side so Postpass doesn't send all tags. */
const SELECTED_TAGS = ["highway", "surface", "tracktype", "smoothness", "bicycle", "cycleway", "mtb:scale"];

const METERS_PER_DEGREE_LAT = 111_320;

// The chunk line is split into pieces of about this length (or at most this many points), each
// with its own small bounding box. One box around the whole chunk line (~11 × 13 km for the
// 18.9 km test route) made PostGIS scan far more than the 80 m corridor; EXPLAIN on 2026-11-25:
// one box via CTE → cost 681 077, queue "slow"; one literal box → ~1 400–1 900, "medium";
// ~1 km pieces → 355 (18.9 km) / 549 (Grunewald chunk), "medium". Still one HTTP request.
const PIECE_LENGTH_METERS = 1000;
const PIECE_MAX_POINTS = 10;

// Box margin on top of the radius, so the index pre-filter never cuts off a candidate that the
// exact ST_DWithin check would keep.
const BBOX_MARGIN = 1.5;

function approxDistanceMeters(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = b.lat - a.lat;
  return Math.hypot(x, y) * METERS_PER_DEGREE_LAT;
}

/** Inserts points on straight stretches longer than PIECE_LENGTH_METERS (exactly on the line). */
function densify(points: LatLon[]): LatLon[] {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.ceil(approxDistanceMeters(a, b) / PIECE_LENGTH_METERS);
    for (let k = 1; k < steps; k++) {
      out.push({ lat: a.lat + ((b.lat - a.lat) * k) / steps, lon: a.lon + ((b.lon - a.lon) * k) / steps });
    }
    out.push(b);
  }
  return out;
}

/** Consecutive pieces of the line; neighbouring pieces share their end/start point. */
function splitIntoPieces(points: LatLon[]): LatLon[][] {
  if (points.length === 1) return [points];
  const dense = densify(points);
  const pieces: LatLon[][] = [];
  let current = [dense[0]];
  let length = 0;
  for (let i = 1; i < dense.length; i++) {
    length += approxDistanceMeters(dense[i - 1], dense[i]);
    current.push(dense[i]);
    if (length >= PIECE_LENGTH_METERS || current.length >= PIECE_MAX_POINTS) {
      pieces.push(current);
      current = [dense[i]];
      length = 0;
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

const num = (n: number) => n.toFixed(7);

/** Literal bbox, expanded by the radius in degrees at the piece's highest latitude (+ margin). */
function expandedEnvelope(points: LatLon[], radiusMeters: number): string {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const maxAbsLat = Math.max(...lats.map(Math.abs));
  const dLat = (radiusMeters / METERS_PER_DEGREE_LAT) * BBOX_MARGIN;
  const dLon = (radiusMeters / (METERS_PER_DEGREE_LAT * Math.cos((maxAbsLat * Math.PI) / 180))) * BBOX_MARGIN;
  return (
    `ST_MakeEnvelope(${num(Math.min(...lons) - dLon)}, ${num(Math.min(...lats) - dLat)}, ` +
    `${num(Math.max(...lons) + dLon)}, ${num(Math.max(...lats) + dLat)}, 4326)`
  );
}

function geographyLiteral(points: LatLon[]): string {
  const coords = points.map((p) => `${num(p.lon)} ${num(p.lat)}`);
  const wkt = coords.length === 1 ? `POINT(${coords[0]})` : `LINESTRING(${coords.join(", ")})`;
  return `'SRID=4326;${wkt}'::geography`;
}

/**
 * SQL for the ways along one chunk — the Postpass equivalent of buildOverpassQuery(): every way
 * (`osm_type = 'W'`; `postpass_line` also holds relations) with a highway tag within
 * radiusMeters of the already simplified chunk line. Per piece: a literal-bbox pre-filter for the
 * spatial index, then the exact distance in metres on geography (storage is EPSG:4326).
 * Pieces are combined with UNION ALL and de-duplicated by way id.
 */
export function buildPostpassQuery(points: LatLon[], radiusMeters: number): string {
  const tagObject = SELECTED_TAGS.map((t) => `'${t}', l.tags->'${t}'`).join(", ");
  const select = `l.osm_id, jsonb_strip_nulls(jsonb_build_object(${tagObject})) AS tags, l.geom`;

  const parts = splitIntoPieces(points).map(
    (piece) =>
      `  SELECT ${select} FROM postpass_line l` +
      ` WHERE l.osm_type = 'W' AND l.tags ? 'highway'` +
      ` AND l.geom && ${expandedEnvelope(piece, radiusMeters)}` +
      ` AND ST_DWithin(l.geom::geography, ${geographyLiteral(piece)}, ${radiusMeters})`
  );

  return (
    `SELECT DISTINCT ON (osm_id) osm_id, tags, geom FROM (\n` +
    `${parts.join("\n  UNION ALL\n")}\n` +
    `) pieces\nORDER BY osm_id`
  );
}

// ---------------------------------------------------------------------------------------------
// Response → Overpass `out geom` shape

interface PostpassFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: { osm_id?: unknown; tags?: unknown };
}

interface OverpassWayElement {
  type: "way";
  id: number;
  tags: Record<string, string>;
  geometry: LatLon[];
}

// Parts closer than this are treated as connected (same node, just repeated at the part border).
const PART_JOIN_EPSILON_METERS = 0.5;

/**
 * Postpass returns each way as a MultiLineString of [lon, lat] coordinates. Overpass gives one
 * polyline of { lat, lon } per way, and lib/mapMatching.ts builds edges from consecutive points.
 * So: swap the coordinates, join parts that connect (end of one = start of the next) in order —
 * identical to Overpass' polyline — and keep parts with a gap as separate elements with the same
 * way id. Joining across a gap would invent an edge Overpass doesn't have; the shared id keeps
 * the matcher's same-way continuity check working.
 */
function toPolylines(coordinates: unknown): LatLon[][] {
  if (!Array.isArray(coordinates)) return [];
  const lines: LatLon[][] = [];
  for (const part of coordinates) {
    if (!Array.isArray(part)) continue;
    const pts = part
      .filter((c): c is [number, number] => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number")
      .map(([lon, lat]) => ({ lat, lon }));
    if (pts.length === 0) continue;

    const previous = lines[lines.length - 1];
    if (previous && approxDistanceMeters(previous[previous.length - 1], pts[0]) <= PART_JOIN_EPSILON_METERS) {
      previous.push(...pts.slice(1));
    } else {
      lines.push(pts);
    }
  }
  return lines;
}

function toOverpassShape(features: PostpassFeature[]): { elements: OverpassWayElement[]; multiPartWays: number } {
  const elements: OverpassWayElement[] = [];
  let multiPartWays = 0;

  for (const feature of features) {
    const id = feature.properties?.osm_id;
    if (typeof id !== "number") continue;
    const rawTags = feature.properties?.tags;
    const tags: Record<string, string> =
      rawTags && typeof rawTags === "object" ? Object.fromEntries(
        Object.entries(rawTags as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      ) : {};

    const lines = feature.geometry?.type === "LineString"
      ? toPolylines([feature.geometry.coordinates])
      : toPolylines(feature.geometry?.coordinates);
    if (lines.length > 1) multiPartWays++;

    for (const geometry of lines) elements.push({ type: "way", id, tags, geometry });
  }

  return { elements, multiPartWays };
}

// ---------------------------------------------------------------------------------------------
// Request

export async function fetchFromPostpass(
  requestId: string,
  requestStart: number,
  points: LatLon[],
  radiusMeters: number,
  failedAttemptsBefore: number
): Promise<WaysResult> {
  if (!POSTPASS_ENDPOINT) {
    return { ok: false, error: "Postpass fallback disabled.", upstreamStatus: 502, queryTimedOut: false };
  }

  const sql = buildPostpassQuery(points, radiusMeters);
  const body = `data=${encodeURIComponent(sql)}`;
  const start = Date.now();
  log(requestId, `→ ${POSTPASS_SOURCE} ${POSTPASS_ENDPOINT} started (timeout ${REQUEST_TIMEOUT_MS}ms, SQL ${sql.length} chars, body ${body.length} bytes)`);

  const fail = (message: string): WaysResult => {
    log(requestId, `← ${POSTPASS_SOURCE} FAILED after ${Date.now() - start}ms: ${message} (no retry)`);
    return { ok: false, error: `${POSTPASS_SOURCE}: ${message}`, upstreamStatus: 502, queryTimedOut: false };
  };

  let response: Response;
  try {
    response = await fetch(POSTPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "RouteRider/0.1 (dev)",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    return fail(isTimeout ? `client-side timeout after ${Date.now() - start}ms` : `network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log(requestId, `← ${POSTPASS_SOURCE} status=${response.status} body="${text.slice(0, 300)}"`);
    return fail(`HTTP ${response.status}`);
  }

  let json: { features?: unknown; postpass_properties?: { timestamp?: unknown } };
  try {
    json = await response.json();
  } catch (err) {
    return fail(`unparseable response: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(json.features)) return fail("response has no features array");

  const { elements, multiPartWays } = toOverpassShape(json.features as PostpassFeature[]);
  const dataTimestamp = typeof json.postpass_properties?.timestamp === "string" ? json.postpass_properties.timestamp : "?";
  log(
    requestId,
    `← ${POSTPASS_SOURCE} status=${response.status} (${Date.now() - start}ms) OK, ${json.features.length} way(s)` +
      `${multiPartWays > 0 ? `, ${multiPartWays} with disconnected parts` : ""}, data timestamp ${dataTimestamp}`
  );
  log(
    requestId,
    `request succeeded via ${POSTPASS_SOURCE} after ${failedAttemptsBefore} failed attempt(s), ${Date.now() - requestStart}ms total`
  );

  return { ok: true, data: keepRelevantTags({ elements }), source: POSTPASS_SOURCE };
}
