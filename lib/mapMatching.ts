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
const CHUNK_TARGET_SEGMENTS = 40; // route segments per Overpass query

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

interface ChunkBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface Chunk {
  segments: RouteSegment[];
  bounds: ChunkBounds;
}

/**
 * Groups consecutive segments into batches, one Overpass query per batch (bbox padded by the
 * search radius), rather than one query per point/segment — required to stay usable on real
 * routes with thousands of points without hitting the public instance's rate limits.
 */
function chunkSegments(
  segments: RouteSegment[],
  targetSegmentsPerChunk: number,
  paddingMeters: number
): Chunk[] {
  const chunks: Chunk[] = [];

  for (let i = 0; i < segments.length; i += targetSegmentsPerChunk) {
    const slice = segments.slice(i, i + targetSegmentsPerChunk);
    const lats = slice.flatMap((s) => [s.start.lat, s.end.lat]);
    const lons = slice.flatMap((s) => [s.start.lon, s.end.lon]);

    const south = Math.min(...lats);
    const north = Math.max(...lats);
    const west = Math.min(...lons);
    const east = Math.max(...lons);

    const latPad = paddingMeters / 111320;
    const lonPad =
      paddingMeters / (111320 * Math.cos(((south + north) / 2) * Math.PI / 180));

    chunks.push({
      segments: slice,
      bounds: {
        south: south - latPad,
        north: north + latPad,
        west: west - lonPad,
        east: east + lonPad,
      },
    });
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
}

async function fetchWaysForBounds(bounds: ChunkBounds): Promise<OsmWay[]> {
  const response = await fetch("/api/overpass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bounds),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.error ? ` ${body.error}` : "";
    throw new Error(`Overpass-Abfrage fehlgeschlagen (${response.status}).${detail}`);
  }

  const data: { elements: OverpassElement[] } = await response.json();

  return data.elements
    .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2)
    .map((el) => ({
      id: el.id,
      nodes: el.geometry!.map((n) => ({ lat: n.lat, lon: n.lon })),
    }));
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

  const chunks = chunkSegments(segments, CHUNK_TARGET_SEGMENTS, SEARCH_RADIUS_METERS);

  const results: MatchedSegment[] = [];
  let previousMatchedWay: OsmWay | null = null;

  // Sequential, spaced-out requests: a good citizen of the public Overpass instance (docs,
  // Section 41), which otherwise starts rate-limiting after just a couple of rapid requests.
  // Each chunk's ways are scored only against that chunk's own segments — a chunk's bbox is
  // already padded by the search radius for those segments, so nothing is missed, and this
  // avoids scoring every segment in the route against every way ever fetched (which would be
  // O(totalSegments × totalWays) and can stall the browser on long, multi-chunk routes).
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);

    const chunkWays = await fetchWaysForBounds(chunks[i].bounds);

    for (const segment of chunks[i].segments) {
      const candidates = scoreCandidates(
        segment,
        chunkWays,
        SEARCH_RADIUS_METERS,
        previousMatchedWay
      );
      const { status, way } = resolveSegmentMatch(candidates);

      results.push({ start: segment.start, end: segment.end, status, wayId: way?.id ?? null });

      if (status === "matched" && way) {
        previousMatchedWay = way;
      }
    }

    onProgress?.({ completedChunks: i + 1, totalChunks: chunks.length });
  }

  return results;
}

/**
 * Own OSM-geometry matching heuristic (D5), chosen over an external service (e.g. Valhalla) for
 * v0.1. Implements the MapMatcher interface so it can be swapped later without touching callers.
 */
export const overpassHeuristicMatcher: MapMatcher = { matchRoute };
