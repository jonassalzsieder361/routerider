import { haversineDistance } from "@/lib/geo";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export interface GpxParseResult {
  points: GpxPoint[];
  distanceMeters: number;
  elevationGainMeters: number | null;
}

export class GpxParseError extends Error {}

// Below this coverage, elevation data is treated as not reliable enough to report (v0.1 calibration parameter).
const MIN_ELEVATION_COVERAGE = 0.9;

export function parseGpx(xmlText: string): GpxParseResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new GpxParseError("Die Datei konnte nicht als GPX gelesen werden.");
  }

  const trackPoints = Array.from(doc.getElementsByTagName("trkpt"));
  const rawPoints =
    trackPoints.length > 0
      ? trackPoints
      : Array.from(doc.getElementsByTagName("rtept"));

  if (rawPoints.length === 0) {
    throw new GpxParseError(
      "Die GPX-Datei enthält keine Track- oder Routenpunkte."
    );
  }

  const points: GpxPoint[] = rawPoints.map((point) => {
    const lat = parseFloat(point.getAttribute("lat") ?? "");
    const lon = parseFloat(point.getAttribute("lon") ?? "");
    const eleNode = point.getElementsByTagName("ele")[0];
    const ele = eleNode ? parseFloat(eleNode.textContent ?? "") : NaN;

    return {
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
    };
  });

  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) {
    throw new GpxParseError("Die GPX-Datei enthält ungültige Koordinaten.");
  }

  let distanceMeters = 0;
  for (let i = 1; i < points.length; i++) {
    distanceMeters += haversineDistance(points[i - 1], points[i]);
  }

  const pointsWithElevation = points.filter((p) => p.ele !== null).length;
  const elevationCoverage = pointsWithElevation / points.length;

  let elevationGainMeters: number | null = null;
  if (elevationCoverage >= MIN_ELEVATION_COVERAGE) {
    let gain = 0;
    for (let i = 1; i < points.length; i++) {
      const prevEle = points[i - 1].ele;
      const currEle = points[i].ele;
      if (prevEle !== null && currEle !== null && currEle > prevEle) {
        gain += currEle - prevEle;
      }
    }
    elevationGainMeters = gain;
  }

  return { points, distanceMeters, elevationGainMeters };
}
