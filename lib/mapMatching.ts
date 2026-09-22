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
const CHUNK_TARGET_DISTANCE_METERS = 40_000; // route length per Overpass query (target range: 30-50 km)

// A chunk is also closed early once its points' bounding box grows wider or taller than this,
// even if it hasn't reached CHUNK_TARGET_DISTANCE_METERS yet. A long, thin, mostly-straight
// route (point-to-point rather than a loop) can rack up a huge bounding box well before the
// distance target — the `around` query's cost to Overpass scales with the area it has to check
// proximity against, not just the point count, and a wide-bbox chunk can blow Overpass's own
// internal query timeout even though our request otherwise looks identical in size to a
// same-point-count chunk from a tighter, loopier route.
const CHUNK_BBOX_THRESHOLD_METERS = 15_000;

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
  bboxWidthMeters: number;
  bboxHeightMeters: number;
}

interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function emptyBoundingBox(): BoundingBox {
  return { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
}

function expandBoundingBox(box: BoundingBox, point: LatLon): void {
  if (point.lat < box.minLat) box.minLat = point.lat;
  if (point.lat > box.maxLat) box.maxLat = point.lat;
  if (point.lon < box.minLon) box.minLon = point.lon;
  if (point.lon > box.maxLon) box.maxLon = point.lon;
}

/** Bounding box extent in meters — ground distance across it, not a naive degree delta. */
function boundingBoxDimensionsMeters(box: BoundingBox): { widthMeters: number; heightMeters: number } {
  const midLat = (box.minLat + box.maxLat) / 2;
  const midLon = (box.minLon + box.maxLon) / 2;

  return {
    widthMeters: haversineDistance({ lat: midLat, lon: box.minLon }, { lat: midLat, lon: box.maxLon }),
    heightMeters: haversineDistance({ lat: box.minLat, lon: midLon }, { lat: box.maxLat, lon: midLon }),
  };
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

/** Diagnostic only — logs chunk sizes, bounding box extent and point-thinning stats before any Overpass calls fire. */
function logChunkStats(chunks: Chunk[]): void {
  console.log(`[mapMatching] ${chunks.length} chunk(s) for this route:`);

  chunks.forEach((chunk, i) => {
    const distanceKm =
      chunk.segments.reduce((sum, s) => sum + haversineDistance(s.start, s.end), 0) / 1000;

    console.log(
      `[mapMatching]   chunk ${i + 1}/${chunks.length}: ${distanceKm.toFixed(1)}km, ` +
        `${chunk.segments.length} segments, ${chunk.aroundPoints.length} around-query points, ` +
        `bbox ${(chunk.bboxWidthMeters / 1000).toFixed(1)}x${(chunk.bboxHeightMeters / 1000).toFixed(1)}km`
    );
  });
}

/**
 * Groups consecutive segments into batches by accumulated route distance — one Overpass query
 * per ~CHUNK_TARGET_DISTANCE_METERS of route — rather than one query per point/segment or one
 * for the whole route, to stay usable on real routes with thousands of points without hitting
 * the public instance's rate limits. A chunk is also closed early if its bounding box exceeds
 * CHUNK_BBOX_THRESHOLD_METERS, whichever comes first — see that constant's comment.
 */
function chunkSegments(
  segments: RouteSegment[],
  targetDistanceMeters: number,
  bboxThresholdMeters: number
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentSlice: RouteSegment[] = [];
  let currentDistance = 0;
  let currentBox = emptyBoundingBox();

  function pushChunk() {
    const { widthMeters, heightMeters } = boundingBoxDimensionsMeters(currentBox);
    chunks.push({
      segments: currentSlice,
      aroundPoints: thinPoints(chunkRoutePoints(currentSlice), AROUND_POINT_STRIDE),
      bboxWidthMeters: widthMeters,
      bboxHeightMeters: heightMeters,
    });
  }

  for (const segment of segments) {
    if (currentSlice.length === 0) expandBoundingBox(currentBox, segment.start);

    currentSlice.push(segment);
    currentDistance += haversineDistance(segment.start, segment.end);
    expandBoundingBox(currentBox, segment.end);

    const { widthMeters, heightMeters } = boundingBoxDimensionsMeters(currentBox);
    const bboxTooLarge = widthMeters > bboxThresholdMeters || heightMeters > bboxThresholdMeters;

    if (currentDistance >= targetDistanceMeters || bboxTooLarge) {
      pushChunk();
      currentSlice = [];
      currentDistance = 0;
      currentBox = emptyBoundingBox();
    }
  }

  if (currentSlice.length > 0) {
    pushChunk();
  }

  return chunks;
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
  const resampled = resampleRoute(rawPoints, MIN_POINT_SPACING_METERS);
  const segments = buildSegments(resampled);

  if (segments.length === 0) return [];

  const chunks = chunkSegments(segments, CHUNK_TARGET_DISTANCE_METERS, CHUNK_BBOX_THRESHOLD_METERS);
  logChunkStats(chunks);

  const results: MatchedSegment[] = [];
  let previousMatchedWay: OsmWay | null = null;

  // Sequential, spaced-out requests: a good citizen of the public Overpass instance (docs,
  // Section 41), which otherwise starts rate-limiting after just a couple of rapid requests.
  // Each chunk's ways are scored only against that chunk's own segments — an `around` query
  // already covers those segments (see AROUND_QUERY_RADIUS_METERS), so nothing is missed, and
  // this avoids scoring every segment in the route against every way ever fetched (which would
  // be O(totalSegments × totalWays) and can stall the browser on long, multi-chunk routes).
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);

    const chunkLabel = `chunk ${i + 1}/${chunks.length}`;
    const chunkWays = await fetchWaysAround(
      chunks[i].aroundPoints,
      AROUND_QUERY_RADIUS_METERS,
      chunkLabel
    );

    let chunkMatched = 0;
    let chunkAmbiguous = 0;
    let chunkUnmatched = 0;

    for (const segment of chunks[i].segments) {
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
        `${chunkUnmatched} unmatched (of ${chunks[i].segments.length} segments, ` +
        `${chunkWays.length} candidate ways)`
    );

    onProgress?.({ completedChunks: i + 1, totalChunks: chunks.length });
  }

  return results;
}

/**
 * Own OSM-geometry matching heuristic (D5), chosen over an external service (e.g. Valhalla) for
 * v0.1. Implements the MapMatcher interface so it can be swapped later without touching callers.
 */
export const overpassHeuristicMatcher: MapMatcher = { matchRoute };
