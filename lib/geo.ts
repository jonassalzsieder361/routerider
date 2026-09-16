export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_METERS = 6371000;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineDistance(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function bearing(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lon - a.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two undirected bearings (0-90°): a path and a way can be matched end-to-start. */
export function undirectedBearingDiff(bearingA: number, bearingB: number): number {
  const diff = Math.abs(bearingA - bearingB) % 360;
  const folded = diff > 180 ? 360 - diff : diff;
  return Math.min(folded, 180 - folded);
}

/**
 * Projects points to local planar meters relative to `origin`. Only valid for points within a
 * few km of `origin` — sufficient for the tens-of-meters map matching in this module.
 */
export function projectRelativeTo(origin: LatLon, point: LatLon): { x: number; y: number } {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(toRadians(origin.lat));
  return {
    x: (point.lon - origin.lon) * metersPerDegLon,
    y: (point.lat - origin.lat) * metersPerDegLat,
  };
}

/** Shortest distance in meters from `point` to the segment [segStart, segEnd]. */
export function distancePointToSegmentMeters(
  point: LatLon,
  segStart: LatLon,
  segEnd: LatLon
): number {
  const p = projectRelativeTo(point, point);
  const a = projectRelativeTo(point, segStart);
  const b = projectRelativeTo(point, segEnd);

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;

  if (lengthSquared === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared)
  );
  const closestX = a.x + t * abx;
  const closestY = a.y + t * aby;

  return Math.hypot(p.x - closestX, p.y - closestY);
}

export function midpoint(a: LatLon, b: LatLon): LatLon {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}
