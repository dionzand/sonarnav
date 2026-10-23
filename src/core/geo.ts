// Geodesic helpers. Coordinates are [lon, lat] in degrees (GeoJSON order).
export type LngLat = [number, number];

export const EARTH_RADIUS = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalize360(toDeg(Math.atan2(y, x)));
}

/** Point reached travelling `dist` metres from `from` on bearing `brg`. */
export function destination(from: LngLat, brg: number, dist: number): LngLat {
  const δ = dist / EARTH_RADIUS;
  const θ = toRad(brg);
  const φ1 = toRad(from[1]);
  const λ1 = toRad(from[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [normalize180(toDeg(λ2)), toDeg(φ2)];
}

export function normalize360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Wrap to (-180, 180]. */
export function normalize180(deg: number): number {
  const d = normalize360(deg);
  return d > 180 ? d - 360 : d;
}

/** Signed smallest angle from heading `from` to heading `to`; positive = clockwise (right). */
export function angleDiff(from: number, to: number): number {
  return normalize180(to - from);
}

// Local equirectangular projection (metres) — accurate enough over a few km.
function toLocal(origin: LngLat, p: LngLat): [number, number] {
  const k = Math.cos(toRad(origin[1]));
  return [toRad(p[0] - origin[0]) * EARTH_RADIUS * k, toRad(p[1] - origin[1]) * EARTH_RADIUS];
}

export interface Projection {
  /** Closest point on the polyline. */
  point: LngLat;
  /** Index of the segment start vertex. */
  segment: number;
  /** Fraction along that segment, 0..1. */
  t: number;
  /** Distance from the query point to the polyline (m). */
  distance: number;
  /** Distance along the polyline from its start to `point` (m). */
  along: number;
}

/** Cumulative distance at each vertex. */
export function cumulativeDistances(line: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + distance(line[i - 1], line[i]));
  return out;
}

/**
 * Project p onto a polyline. `fromSegment`/`toSegment` restrict the search window,
 * which keeps progress monotonic on routes that double back on themselves.
 */
export function projectOnLine(
  p: LngLat,
  line: LngLat[],
  cum: number[] = cumulativeDistances(line),
  fromSegment = 0,
  toSegment = line.length - 2,
): Projection {
  let best: Projection = { point: line[0], segment: 0, t: 0, distance: Infinity, along: 0 };
  const lo = Math.max(0, fromSegment);
  const hi = Math.min(line.length - 2, toSegment);
  for (let i = lo; i <= hi; i++) {
    const a = line[i];
    const b = line[i + 1];
    const [bx, by] = toLocal(a, b);
    const [px, py] = toLocal(a, p);
    const len2 = bx * bx + by * by;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    const dx = px - t * bx;
    const dy = py - t * by;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best.distance) {
      const point: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      best = { point, segment: i, t, distance: d, along: cum[i] + (cum[i + 1] - cum[i]) * t };
    }
  }
  return best;
}

/** Point at distance `along` metres along the polyline (clamped to its ends). */
export function pointAlong(line: LngLat[], cum: number[], along: number): { point: LngLat; segment: number } {
  if (along <= 0) return { point: line[0], segment: 0 };
  const total = cum[cum.length - 1];
  if (along >= total) return { point: line[line.length - 1], segment: Math.max(0, line.length - 2) };
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < along) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen === 0 ? 0 : (along - cum[i]) / segLen;
  const a = line[i];
  const b = line[i + 1];
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], segment: i };
}
