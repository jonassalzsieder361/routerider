import {
  bearing,
  distancePointToSegmentMeters,
  haversineDistance,
  midpoint,
  undirectedBearingDiff,
  type LatLon,
} from "@/lib/geo";

export type SegmentMatchStatus = "matched" | "ambiguous" | "unmatched";

export interface RouteSegment {
  start: LatLon;
  end: LatLon;
}

export interface MatchedSegment extends RouteSegment {
  status: SegmentMatchStatus;
  wayId: number | null;
}

export interface OsmWay {
  id: number;
  nodes: LatLon[];
}

export type MatchProgress = { completedChunks: number; totalChunks: number };

export interface MapMatcher {
  matchRoute(
    points: LatLon[],
    onProgress?: (progress: MatchProgress) => void
  ): Promise<MatchedSegment[]>;
}

// v0.1 calibration parameters (docs/RouteRider Tire Pressure - Resolved Decisions D4-D7.md, D5).
// Adjustable, not fixed truths — kept centralized here, matching the pattern used for terrain modifiers.
const SEARCH_RADIUS_METERS = 20; // within the documented 15-25 m range
const MIN_POINT_SPACING_METERS = 20; // resample route before matching to stabilize bearing calculation
const CHUNK_TARGET_DISTANCE_METERS = 17_500; // route length per Overpass query (target range: 15-20 km)

// Up to this many chunk fetches run at once. Keeps overall wait time down on long routes
// without hammering the public Overpass instances (docs, Section 41) as hard as full parallelism.
const CHUNK_FETCH_CONCURRENCY = 2;

// The `around` query is sent only for a thinned subset of each chunk's points (every Nth), to
// keep the query small — but that opens gaps between the points we actually query around. A
// point exactly midway between two kept points can be up to (stride * MIN_POINT_SPACING_METERS)
// / 2 away from the nearest kept point, so the query radius is widened by that amount to
// guarantee we still fetch every way within SEARCH_RADIUS_METERS of the *original* dense route —
// scoreCandidates still clamps to SEARCH_RADIUS_METERS afterwards, so this only affects which
// ways are fetched as candidates, never the actual match distance.
const AROUND_POINT_STRIDE = 8; // within the suggested every-5th-to-10th-point range
const AROUND_QUERY_RADIUS_METERS =
  SEARCH_RADIUS_METERS + (AROUND_POINT_STRIDE * MIN_POINT_SPACING_METERS) / 2;

// Spacing between chunk requests, on top of the retry/backoff in app/api/overpass/route.ts —
// the public Overpass instance starts returning 429/504 after just a couple of rapid requests.
const CHUNK_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WEIGHT_DISTANCE = 0.5;
const WEIGHT_DIRECTION = 0.3;
const WEIGHT_CONTINUITY = 0.2;

const MIN_MATCH_SCORE = 0.5;
const AMBIGUITY_MARGIN = 0.08;

const CONTINUITY_SAME_WAY = 1;
const CONTINUITY_ADJACENT_WAY = 0.5;
const CONTINUITY_UNRELATED_WAY = 0;
const ADJACENT_NODE_EPSILON_METERS = 2;

function resampleRoute(points: LatLon[], minSpacingMeters: number): LatLon[] {
  if (points.length === 0) return [];

  const resampled: LatLon[] = [points[0]];
  let last = points[0];

  for (let i = 1; i < points.length; i++) {
    if (haversineDistance(last, points[i]) >= minSpacingMeters) {
      resampled.push(points[i]);
      last = points[i];
    }
  }

  const finalPoint = points[points.length - 1];
  if (resampled[resampled.length - 1] !== finalPoint) {
    resampled.push(finalPoint);
  }

  return resampled;
}

function buildSegments(points: LatLon[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({ start: points[i - 1], end: points[i] });
  }
  return segments;
}

interface Chunk {
  segments: RouteSegment[];
  aroundPoints: LatLon[];
  rawPointCount: number;
  rangeStartKm: number;
  rangeEndKm: number;
}

/** Every Nth point of the chunk's own route geometry, always keeping the first and last point. */
function thinPoints(points: LatLon[], stride: number): LatLon[] {
  if (points.length <= 2) return points;

  const thinned: LatLon[] = [];
  for (let i = 0; i < points.length; i += stride) thinned.push(points[i]);

  const last = points[points.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);

  return thinned;
}

function chunkRoutePoints(slice: RouteSegment[]): LatLon[] {
  const points = [slice[0].start];
  for (const segment of slice) points.push(segment.end);
  return points;
}

/**
 * Groups consecutive segments into batches by accumulated route distance — one Overpass query
 * per ~CHUNK_TARGET_DISTANCE_METERS of route — rather than one query per point/segment or one
 * for the whole route, to stay usable on real routes with thousands of points without hitting
 * the public instance's rate limits.
 */
function chunkSegments(segments: RouteSegment[], targetDistanceMeters: number): Chunk[] {
  const chunks: Chunk[] = [];
  let currentSlice: RouteSegment[] = [];
  let currentDistance = 0;
  let totalDistanceSoFar = 0;
  let rangeStart = 0;

  function pushChunk() {
    const rawPoints = chunkRoutePoints(currentSlice);
    totalDistanceSoFar += currentDistance;

    chunks.push({
      segments: currentSlice,
      aroundPoints: thinPoints(rawPoints, AROUND_POINT_STRIDE),
      rawPointCount: rawPoints.length,
      rangeStartKm: rangeStart / 1000,
      rangeEndKm: totalDistanceSoFar / 1000,
    });

    rangeStart = totalDistanceSoFar;
  }

  for (const segment of segments) {
    currentSlice.push(segment);
    currentDistance += haversineDistance(segment.start, segment.end);

    if (currentDistance >= targetDistanceMeters) {
      pushChunk();
      currentSlice = [];
      currentDistance = 0;
    }
  }

  if (currentSlice.length > 0) {
    pushChunk();
  }

  return chunks;
}

function logChunkStats(chunks: Chunk[]): void {
  console.log(`[mapMatching] ${chunks.length} chunk(s) for this route:`);

  chunks.forEach((chunk, i) => {
    const coordListLength = chunk.aroundPoints.map((p) => `${p.lat},${p.lon}`).join(",").length;

    console.log(
      `[mapMatching]   chunk ${i + 1}/${chunks.length}: km ${chunk.rangeStartKm.toFixed(1)}-${chunk.rangeEndKm.toFixed(1)}, ` +
        `${chunk.segments.length} segments, ${chunk.rawPointCount} points before thinning -> ` +
        `${chunk.aroundPoints.length} after (~${coordListLength} chars coord list)`
    );
  });
}

interface OverpassGeometryNode {
  lat: number;
  lon: number;
}

interface OverpassElement {
  type: string;
  id: number;
  geometry?: OverpassGeometryNode[];
}

async function fetchWaysAround(
  points: LatLon[],
  radiusMeters: number,
  chunkLabel: string
): Promise<OsmWay[]> {
  const response = await fetch("/api/overpass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points, radiusMeters }),
  });

  console.log(`[mapMatching] ${chunkLabel}: Overpass HTTP status=${response.status}`);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.error ? ` ${body.error}` : "";
    throw new Error(`Overpass-Abfrage fehlgeschlagen (${response.status}).${detail}`);
  }

  const data: { elements: OverpassElement[] } = await response.json();

  const ways = data.elements
    .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2)
    .map((el) => ({
      id: el.id,
      nodes: el.geometry!.map((n) => ({ lat: n.lat, lon: n.lon })),
    }));

  console.log(`[mapMatching] ${chunkLabel}: ${ways.length} OSM way(s) returned`);

  return ways;
}

interface NearestEdge {
  distanceMeters: number;
  edgeStart: LatLon;
  edgeEnd: LatLon;
}

function nearestEdgeOnWay(way: OsmWay, point: LatLon): NearestEdge | null {
  let best: NearestEdge | null = null;

  for (let i = 1; i < way.nodes.length; i++) {
    const edgeStart = way.nodes[i - 1];
    const edgeEnd = way.nodes[i];
    const distanceMeters = distancePointToSegmentMeters(point, edgeStart, edgeEnd);

    if (!best || distanceMeters < best.distanceMeters) {
      best = { distanceMeters, edgeStart, edgeEnd };
    }
  }

  return best;
}

function sharesNodeWithinEpsilon(a: OsmWay, b: OsmWay, epsilonMeters: number): boolean {
  return a.nodes.some((nodeA) =>
    b.nodes.some((nodeB) => haversineDistance(nodeA, nodeB) <= epsilonMeters)
  );
}

interface Candidate {
  way: OsmWay;
  score: number;
}

/**
 * Scores each candidate way for one route segment on distance, direction agreement and
 * continuity with the previously matched way (D5). Continuity is dropped — and its weight
 * redistributed — for the first segment, since there is no previous match yet.
 */
function scoreCandidates(
  segment: RouteSegment,
  candidateWays: OsmWay[],
  searchRadiusMeters: number,
  previousMatchedWay: OsmWay | null
): Candidate[] {
  const segmentMid = midpoint(segment.start, segment.end);
  const segmentBearing = bearing(segment.start, segment.end);

  const hasPrevious = previousMatchedWay !== null;
  const [wDistance, wDirection, wContinuity] = hasPrevious
    ? [WEIGHT_DISTANCE, WEIGHT_DIRECTION, WEIGHT_CONTINUITY]
    : [
        WEIGHT_DISTANCE / (WEIGHT_DISTANCE + WEIGHT_DIRECTION),
        WEIGHT_DIRECTION / (WEIGHT_DISTANCE + WEIGHT_DIRECTION),
        0,
      ];

  const candidates: Candidate[] = [];

  for (const way of candidateWays) {
    const nearestEdge = nearestEdgeOnWay(way, segmentMid);
    if (!nearestEdge || nearestEdge.distanceMeters > searchRadiusMeters) continue;

    const distanceScore = Math.max(0, 1 - nearestEdge.distanceMeters / searchRadiusMeters);

    const edgeBearing = bearing(nearestEdge.edgeStart, nearestEdge.edgeEnd);
    const angleDiff = undirectedBearingDiff(segmentBearing, edgeBearing);
    const directionScore = Math.max(0, 1 - angleDiff / 90);

    let continuityScore = CONTINUITY_UNRELATED_WAY;
    if (hasPrevious) {
      if (way.id === previousMatchedWay!.id) {
        continuityScore = CONTINUITY_SAME_WAY;
      } else if (
        sharesNodeWithinEpsilon(way, previousMatchedWay!, ADJACENT_NODE_EPSILON_METERS)
      ) {
        continuityScore = CONTINUITY_ADJACENT_WAY;
      }
    }

    const score =
      wDistance * distanceScore + wDirection * directionScore + wContinuity * continuityScore;

    candidates.push({ way, score });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** Picks the winner for a segment, or flags it Ambiguous/Unmatched (D5, point 4). */
function resolveSegmentMatch(candidates: Candidate[]): {
  status: SegmentMatchStatus;
  way: OsmWay | null;
} {
  if (candidates.length === 0) {
    return { status: "unmatched", way: null };
  }

  const [best, second] = candidates;

  if (best.score < MIN_MATCH_SCORE) {
    return { status: "unmatched", way: null };
  }

  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return { status: "ambiguous", way: null };
  }

  return { status: "matched", way: best.way };
}

/**
 * Fetches every chunk's ways with up to CHUNK_FETCH_CONCURRENCY requests in flight at once,
 * reporting progress as each one lands (in whatever order they complete). Results are still
 * returned indexed by original chunk order, so the caller can score them sequentially — that
 * ordering matters for the continuity check (D5, point 3), which depends on the previous
 * chunk's match and would break if chunks were scored out of route order.
 */
async function fetchAllChunkWays(
  chunks: Chunk[],
  onProgress?: (progress: MatchProgress) => void
): Promise<OsmWay[][]> {
  const results: OsmWay[][] = new Array(chunks.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    let isFirstForThisWorker = true;

    while (true) {
      const i = nextIndex++;
      if (i >= chunks.length) return;

      // Politeness spacing per worker — with CHUNK_FETCH_CONCURRENCY workers running, requests
      // still land staggered rather than all at once, without serializing the whole route.
      if (!isFirstForThisWorker) await sleep(CHUNK_DELAY_MS);
      isFirstForThisWorker = false;

      try {
        results[i] = await fetchWaysAround(
          chunks[i].aroundPoints,
          AROUND_QUERY_RADIUS_METERS,
          `chunk ${i + 1}/${chunks.length}`
        );
      } catch (err) {
        // One chunk failing (e.g. a transient rate-limit hit) shouldn't abort the whole route —
        // its segments just come back Unmatched, same as a chunk with no nearby OSM ways at all.
        console.warn(
          `[mapMatching] chunk ${i + 1}/${chunks.length} fetch failed, its segments will be Unmatched:`,
          err instanceof Error ? err.message : err
        );
        results[i] = [];
      }

      completed++;
      onProgress?.({ completedChunks: completed, totalChunks: chunks.length });
    }
  }

  const workerCount = Math.min(CHUNK_FETCH_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function matchRoute(
  rawPoints: LatLon[],
  onProgress?: (progress: MatchProgress) => void
): Promise<MatchedSegment[]> {
  const resampled = resampleRoute(rawPoints, MIN_POINT_SPACING_METERS);
  const segments = buildSegments(resampled);

  if (segments.length === 0) return [];

  const chunks = chunkSegments(segments, CHUNK_TARGET_DISTANCE_METERS);
  logChunkStats(chunks);

  const chunkWaysByIndex = await fetchAllChunkWays(chunks, onProgress);

  // Each chunk's ways are scored only against that chunk's own segments — an `around` query
  // already covers those segments (see AROUND_QUERY_RADIUS_METERS), so nothing is missed, and
  // this avoids scoring every segment in the route against every way ever fetched (which would
  // be O(totalSegments × totalWays) and can stall the browser on long, multi-chunk routes).
  const results: MatchedSegment[] = [];
  let previousMatchedWay: OsmWay | null = null;

  for (let i = 0; i < chunks.length; i++) {
    let chunkMatched = 0;
    let chunkAmbiguous = 0;
    let chunkUnmatched = 0;

    for (const segment of chunks[i].segments) {
      const candidates = scoreCandidates(
        segment,
        chunkWaysByIndex[i],
        SEARCH_RADIUS_METERS,
        previousMatchedWay
      );
      const { status, way } = resolveSegmentMatch(candidates);

      results.push({ start: segment.start, end: segment.end, status, wayId: way?.id ?? null });

      if (status === "matched") chunkMatched++;
      else if (status === "ambiguous") chunkAmbiguous++;
      else chunkUnmatched++;

      if (status === "matched" && way) {
        previousMatchedWay = way;
      }
    }

    console.log(
      `[mapMatching] chunk ${i + 1}/${chunks.length}: ${chunkMatched} matched, ${chunkAmbiguous} ambiguous, ` +
        `${chunkUnmatched} unmatched (of ${chunks[i].segments.length} segments, ` +
        `${chunkWaysByIndex[i].length} candidate ways)`
    );
  }

  return results;
}

/**
 * Own OSM-geometry matching heuristic (D5), chosen over an external service (e.g. Valhalla) for
 * v0.1. Implements the MapMatcher interface so it can be swapped later without touching callers.
 */
export const overpassHeuristicMatcher: MapMatcher = { matchRoute };
