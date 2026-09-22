import { haversineDistance } from "@/lib/geo";
import type { MatchedSegment } from "@/lib/mapMatching";

export type SurfaceClass = "paved" | "gravel" | "trail" | "unknown";

/** Direct = read from surface=*. Inferred = derived via D7 rule table. None = no matched way to classify at all. */
export type ClassificationSource = "direct" | "inferred" | "none";

export interface SurfaceClassification {
  surfaceClass: SurfaceClass;
  source: ClassificationSource;
}

export interface ClassifiedSegment extends MatchedSegment {
  surfaceClass: SurfaceClass;
  source: ClassificationSource;
}

/** Distance-weighted percentage (0-100) of the route per surface class. */
export type SurfaceDistribution = Record<SurfaceClass, number>;

// docs/RouteRider Tire Pressure.pdf, Section 11 "OSM Surface Classification".
const PAVED_SURFACE_VALUES = new Set([
  "asphalt",
  "concrete",
  "concrete:plates",
  "concrete:lanes",
  "paved",
  "paving_stones",
  "sett",
  "chipseal",
]);

const GRAVEL_SURFACE_VALUES = new Set([
  "gravel",
  "compacted",
  "fine_gravel",
  "unpaved",
  "crushed_shell",
  "pebblestone",
]);

const TRAIL_SURFACE_VALUES = new Set([
  "dirt",
  "earth",
  "ground",
  "grass",
  "sand",
  "mud",
  "rock",
  "woodchips",
]);

function classifyBySurfaceTag(surface: string): SurfaceClass {
  if (PAVED_SURFACE_VALUES.has(surface)) return "paved";
  if (GRAVEL_SURFACE_VALUES.has(surface)) return "gravel";
  if (TRAIL_SURFACE_VALUES.has(surface)) return "trail";
  return "unknown";
}

// docs/RouteRider Tire Pressure - Resolved Decisions D4-D7.md, D7 "Surface Inference Rules".
// Row order matters: evaluated top to bottom, first match wins.
const TRAIL_HIGHWAY_VALUES = new Set(["path", "bridleway", "footway"]);
const PAVED_HIGHWAY_VALUES = new Set([
  "residential",
  "tertiary",
  "secondary",
  "primary",
  "unclassified",
]);

function classifyByInference(tags: Record<string, string>): SurfaceClass {
  const tracktype = tags.tracktype;
  const highway = tags.highway;

  if (tracktype === "grade1" || tracktype === "grade2") return "gravel";
  if (tracktype === "grade3" || tracktype === "grade4" || tracktype === "grade5") return "trail";
  if (!tracktype && highway && TRAIL_HIGHWAY_VALUES.has(highway)) return "trail";
  if (highway === "cycleway") return "paved";
  if (highway && PAVED_HIGHWAY_VALUES.has(highway)) return "paved";
  if (!tracktype && highway === "track") return "gravel"; // low confidence, per D7
  return "unknown";
}

/**
 * Classifies one matched segment's surface (Phase 4). Ambiguous/Unmatched segments from Phase 3
 * carry no way tags and become Unknown with no classification source.
 */
export function classifySegment(segment: MatchedSegment): SurfaceClassification {
  if (segment.status !== "matched" || !segment.tags) {
    return { surfaceClass: "unknown", source: "none" };
  }

  const surface = segment.tags.surface;
  if (surface) {
    return { surfaceClass: classifyBySurfaceTag(surface), source: "direct" };
  }

  return { surfaceClass: classifyByInference(segment.tags), source: "inferred" };
}

/** Classifies every matched segment and computes the distance-weighted surface mix for the whole route. */
export function classifyRoute(segments: MatchedSegment[]): {
  segments: ClassifiedSegment[];
  distribution: SurfaceDistribution;
} {
  const classified: ClassifiedSegment[] = segments.map((segment) => ({
    ...segment,
    ...classifySegment(segment),
  }));

  const lengths: Record<SurfaceClass, number> = { paved: 0, gravel: 0, trail: 0, unknown: 0 };
  let totalLength = 0;

  for (const segment of classified) {
    const length = haversineDistance(segment.start, segment.end);
    lengths[segment.surfaceClass] += length;
    totalLength += length;
  }

  const distribution: SurfaceDistribution =
    totalLength === 0
      ? { paved: 0, gravel: 0, trail: 0, unknown: 0 }
      : {
          paved: (lengths.paved / totalLength) * 100,
          gravel: (lengths.gravel / totalLength) * 100,
          trail: (lengths.trail / totalLength) * 100,
          unknown: (lengths.unknown / totalLength) * 100,
        };

  return { segments: classified, distribution };
}
