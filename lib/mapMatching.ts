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
  /** OSM tags of the matched way (surface, tracktype, highway, ...), for Phase 4 Surface Classification. Null unless status is "matched". */
  tags: Record<string, string> | null;
}

export interface OsmWay {
  id: number;
  nodes: LatLon[];
  tags: Record<string, string>;
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

// Query resolution is deliberately separate from matching resolution (docs/RouteRider - Build
// Guide v0.1.md, Phase 3, "Finale v0.1-Spezifikation für den Overpass-Umbau"): Overpass gets a
// Douglas-Peucker-simplified line, while matching still scores every resampled segment of the
// full route. The simplification only picks a subset of the resampled points by index, so it
// can't alter or overwrite the points used for matching.
const SIMPLIFY_TOLERANCE_METERS = 12;

// Corridor for the Overpass `around` filter only — never the match distance, which stays at
// SEARCH_RADIUS_METERS. Overpass treats a multi-coordinate `around` as a polyline, and the
// simplified line is at most SIMPLIFY_TOLERANCE_METERS off the full route, so this covers every
// way within the matching radius: 20 m matching + 12 m simplification + 8 m margin. If fetching
// proves too tight, raise this (to 50 m first) — not the matching radius.
const QUERY_CORRIDOR_METERS = 40;

// Route length per Overpass query. The route is split into equal parts no longer than this
// (e.g. 57 km → 2 × 28.7 km rather than 50 + 7), so no chunk is needlessly heavy.
const CHUNK_MAX_DISTANCE_METERS = 50_000;

// Each chunk's query line reaches this far into its neighbours, so ways right at a chunk
// boundary are fetched for both sides. Only the query overlaps — every segment is still matched
// exactly once, by exactly one chunk.
const CHUNK_OVERLAP_METERS = 1_000;

// Safety net: when a chunk still fails with Overpass's own query timeout (the `remark` case, see
// app/api/overpass/route.ts), just that chunk is halved and retried — at most this many times in
// a row (down to a quarter of the original length) — instead of re-chunking the whole route.
const MAX_CHUNK_SPLIT_DEPTH = 2;

// Spacing between chunk requests, on top of the retry/backoff in app/api/overpass/route.ts —
// the public Overpass instance starts returning 429/504 after just a couple of rapid requests.
// A general fair-use courtesy: Overpass limits concurrent slots per IP and adds a load-dependent
// cool-down after each request.
const CHUNK_DELAY_MS = 2500;

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

/** Distance along the route from the first point to each point, in meters. */
function cumulativeDistances(points: LatLon[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineDistance(points[i - 1], points[i]));
  }
  return cumulative;
}

/**
 * Douglas-Peucker simplification. Returns the *indices* of the kept points (ascending, always
 * including first and last) rather than a new point array — the caller's points stay the single
 * source of truth. Iterative instead of recursive so long routes can't overflow the stack.
 */
function douglasPeuckerIndices(points: LatLon[], toleranceMeters: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDistance = -1;
    let maxIndex = -1;

    for (let i = first + 1; i < last; i++) {
      const d = distancePointToSegmentMeters(points[i], points[first], points[last]);
      if (d > maxDistance) {
        maxDistance = d;
        maxIndex = i;
      }
    }

    if (maxIndex !== -1 && maxDistance > toleranceMeters) {
      keep[maxIndex] = true;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  const indices: number[] = [];
  keep.forEach((kept, i) => {
    if (kept) indices.push(i);
  });
  return indices;
}

/** The two separate views of one route: full resolution for matching, simplified for Overpass. */
interface RouteGeometry {
  /** Resampled route points — the only points segments are built from and matched against. */
  matchPoints: LatLon[];
  /** segments[i] connects matchPoints[i] and matchPoints[i + 1]. */
  segments: RouteSegment[];
  cumulative: number[];
  /** Indices into matchPoints kept by Douglas-Peucker — used only to build Overpass queries. */
  queryIndices: number[];
}

/** Range of matchPoints covered by a chunk; its segments are startIndex..endIndex-1. */
interface Chunk {
  startIndex: number;
  endIndex: number;
  /** How often this chunk has already been halved after an Overpass query timeout. */
  splitDepth: number;
}

/**
 * Splits the route into equal parts of at most maxDistanceMeters. Consecutive chunks share
 * their boundary point but no segment, so every segment is matched exactly once.
 */
function chunkByDistance(cumulative: number[], maxDistanceMeters: number): Chunk[] {
  const lastIndex = cumulative.length - 1;
  const total = cumulative[lastIndex];
  const chunkCount = Math.max(1, Math.ceil(total / maxDistanceMeters));
  const chunkLength = total / chunkCount;

  const chunks: Chunk[] = [];
  let startIndex = 0;

  for (let c = 1; c <= chunkCount && startIndex < lastIndex; c++) {
    let endIndex = lastIndex;
    if (c < chunkCount) {
      endIndex = startIndex + 1;
      while (endIndex < lastIndex && cumulative[endIndex] < c * chunkLength) endIndex++;
    }
    chunks.push({ startIndex, endIndex, splitDepth: 0 });
    startIndex = endIndex;
  }

  return chunks;
}

/** Halves a chunk at its distance midpoint; null if it is a single segment and can't split. */
function splitChunk(chunk: Chunk, cumulative: number[]): [Chunk, Chunk] | null {
  if (chunk.endIndex - chunk.startIndex < 2) return null;

  const target = (cumulative[chunk.startIndex] + cumulative[chunk.endIndex]) / 2;
  let mid = chunk.startIndex + 1;
  while (mid < chunk.endIndex - 1 && cumulative[mid] < target) mid++;

  const splitDepth = chunk.splitDepth + 1;
  return [
    { startIndex: chunk.startIndex, endIndex: mid, splitDepth },
    { startIndex: mid, endIndex: chunk.endIndex, splitDepth },
  ];
}

/**
 * The simplified query line for one chunk: every Douglas-Peucker point within the chunk plus
 * CHUNK_OVERLAP_METERS on each side, extended by one more kept point at each end so the line
 * fully spans that window (kept points can be far apart on long straight stretches).
 */
function chunkQueryPoints(chunk: Chunk, geometry: RouteGeometry): LatLon[] {
  const { cumulative, queryIndices, matchPoints } = geometry;
  const windowStart = cumulative[chunk.startIndex] - CHUNK_OVERLAP_METERS;
  const windowEnd = cumulative[chunk.endIndex] + CHUNK_OVERLAP_METERS;

  let first = queryIndices.findIndex((idx) => cumulative[idx] >= windowStart);
  if (first === -1) first = queryIndices.length - 1;
  first = Math.max(0, first - 1);

  let last = first;
  while (last < queryIndices.length - 1 && cumulative[queryIndices[last]] <= windowEnd) last++;

  return queryIndices.slice(first, last + 1).map((idx) => matchPoints[idx]);
}

function chunkDistanceKm(chunk: Chunk, cumulative: number[]): string {
  return ((cumulative[chunk.endIndex] - cumulative[chunk.startIndex]) / 1000).toFixed(1);
}

/** Diagnostic only — logs the chunk plan before any Overpass calls fire. */
function logChunkStats(chunks: Chunk[], geometry: RouteGeometry): void {
  const totalKm = (geometry.cumulative[geometry.cumulative.length - 1] / 1000).toFixed(1);
  console.log(
    `[mapMatching] ${totalKm}km route: ${geometry.matchPoints.length} match points, ` +
      `${geometry.queryIndices.length} query points after Douglas-Peucker ` +
      `(${SIMPLIFY_TOLERANCE_METERS}m), ${chunks.length} chunk(s):`
  );

  chunks.forEach((chunk, i) => {
    console.log(
      `[mapMatching]   chunk ${i + 1}/${chunks.length}: ${chunkDistanceKm(chunk, geometry.cumulative)}km, ` +
        `${chunk.endIndex - chunk.startIndex} segments, ` +
        `${chunkQueryPoints(chunk, geometry).length} query points`
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
  tags?: Record<string, string>;
}

/** Overpass ran out of its own query-time budget for this chunk — halving the chunk may help. */
class OverpassQueryTimeoutError extends Error {}

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
    const message = `Overpass-Abfrage fehlgeschlagen (${response.status}).${detail}`;
    throw body?.queryTimedOut ? new OverpassQueryTimeoutError(message) : new Error(message);
  }

  const data: { elements: OverpassElement[] } = await response.json();

  const ways = data.elements
    .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2)
    .map((el) => ({
      id: el.id,
      nodes: el.geometry!.map((n) => ({ lat: n.lat, lon: n.lon })),
      tags: el.tags ?? {},
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

async function matchRoute(
  rawPoints: LatLon[],
  onProgress?: (progress: MatchProgress) => void
): Promise<MatchedSegment[]> {
  const matchPoints = resampleRoute(rawPoints, MIN_POINT_SPACING_METERS);
  const segments = buildSegments(matchPoints);

  if (segments.length === 0) return [];

  const geometry: RouteGeometry = {
    matchPoints,
    segments,
    cumulative: cumulativeDistances(matchPoints),
    queryIndices: douglasPeuckerIndices(matchPoints, SIMPLIFY_TOLERANCE_METERS),
  };

  const queue = chunkByDistance(geometry.cumulative, CHUNK_MAX_DISTANCE_METERS);
  logChunkStats(queue, geometry);

  const results: MatchedSegment[] = [];
  let previousMatchedWay: OsmWay | null = null;
  let completedChunks = 0;
  let requestsSent = 0;

  // Sequential, spaced-out requests: a good citizen of the public Overpass instance (docs,
  // Section 41), which otherwise starts rate-limiting after just a couple of rapid requests.
  // Chunks are processed in route order; a halved chunk's two parts go back to the front of the
  // queue, so results stay in route order. Each chunk's ways are scored only against that
  // chunk's own segments — its query corridor already covers them (see QUERY_CORRIDOR_METERS),
  // and this avoids scoring every segment against every way ever fetched (which would be
  // O(totalSegments × totalWays) and can stall the browser on long, multi-chunk routes).
  while (queue.length > 0) {
    const chunk = queue.shift()!;
    const totalChunks = completedChunks + 1 + queue.length;
    const chunkLabel =
      `chunk ${completedChunks + 1}/${totalChunks}` +
      (chunk.splitDepth > 0 ? ` (split level ${chunk.splitDepth})` : "");

    if (requestsSent > 0) await sleep(CHUNK_DELAY_MS);
    requestsSent++;

    let chunkWays: OsmWay[];
    try {
      chunkWays = await fetchWaysAround(
        chunkQueryPoints(chunk, geometry),
        QUERY_CORRIDOR_METERS,
        chunkLabel
      );
    } catch (err) {
      const halves =
        err instanceof OverpassQueryTimeoutError && chunk.splitDepth < MAX_CHUNK_SPLIT_DEPTH
          ? splitChunk(chunk, geometry.cumulative)
          : null;
      if (!halves) throw err;

      console.log(
        `[mapMatching] ${chunkLabel}: Overpass query timed out, halving this ` +
          `${chunkDistanceKm(chunk, geometry.cumulative)}km chunk into ` +
          `${chunkDistanceKm(halves[0], geometry.cumulative)}km + ` +
          `${chunkDistanceKm(halves[1], geometry.cumulative)}km`
      );
      queue.unshift(...halves);
      continue;
    }

    let chunkMatched = 0;
    let chunkAmbiguous = 0;
    let chunkUnmatched = 0;

    for (const segment of geometry.segments.slice(chunk.startIndex, chunk.endIndex)) {
      const candidates = scoreCandidates(
        segment,
        chunkWays,
        SEARCH_RADIUS_METERS,
        previousMatchedWay
      );
      const { status, way } = resolveSegmentMatch(candidates);

      results.push({
        start: segment.start,
        end: segment.end,
        status,
        wayId: way?.id ?? null,
        tags: way?.tags ?? null,
      });

      if (status === "matched") chunkMatched++;
      else if (status === "ambiguous") chunkAmbiguous++;
      else chunkUnmatched++;

      if (status === "matched" && way) {
        previousMatchedWay = way;
      }
    }

    console.log(
      `[mapMatching] ${chunkLabel}: ${chunkMatched} matched, ${chunkAmbiguous} ambiguous, ` +
        `${chunkUnmatched} unmatched (of ${chunk.endIndex - chunk.startIndex} segments, ` +
        `${chunkWays.length} candidate ways)`
    );

    completedChunks++;
    onProgress?.({ completedChunks, totalChunks: completedChunks + queue.length });
  }

  return results;
}

/**
 * Own OSM-geometry matching heuristic (D5), chosen over an external service (e.g. Valhalla) for
 * v0.1. Implements the MapMatcher interface so it can be swapped later without touching callers.
 */
export const overpassHeuristicMatcher: MapMatcher = { matchRoute };
