import { LngLat, distance } from '../core/geo';

/** Walkable/cyclable street segments with a coarse grid index for fast nearest-segment lookup. */
export class StreetNetwork {
  private segments: [LngLat, LngLat][] = [];
  private grid = new Map<string, number[]>();
  private static CELL = 0.0005; // ≈ 35–55 m

  constructor(lines: LngLat[][]) {
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const idx = this.segments.push([line[i], line[i + 1]]) - 1;
        for (const key of this.cellsFor(line[i], line[i + 1])) {
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(idx);
          else this.grid.set(key, [idx]);
        }
      }
    }
  }

  get size(): number {
    return this.segments.length;
  }

  /** Closest point on any street, or null if none in the surrounding cells. */
  nearest(p: LngLat): { point: LngLat; distance: number } | null {
    const C = StreetNetwork.CELL;
    const cx = Math.floor(p[0] / C);
    const cy = Math.floor(p[1] / C);
    const seen = new Set<number>();
    let best: { point: LngLat; distance: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const idx of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const [a, b] = this.segments[idx];
          const q = closestOnSegment(p, a, b);
          const d = distance(p, q);
          if (!best || d < best.distance) best = { point: q, distance: d };
        }
      }
    }
    return best;
  }

  private cellsFor(a: LngLat, b: LngLat): string[] {
    const C = StreetNetwork.CELL;
    const x0 = Math.floor(Math.min(a[0], b[0]) / C);
    const x1 = Math.floor(Math.max(a[0], b[0]) / C);
    const y0 = Math.floor(Math.min(a[1], b[1]) / C);
    const y1 = Math.floor(Math.max(a[1], b[1]) / C);
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
    return keys;
  }
}

function closestOnSegment(p: LngLat, a: LngLat, b: LngLat): LngLat {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const bx = (b[0] - a[0]) * k;
  const by = b[1] - a[1];
  const px = (p[0] - a[0]) * k;
  const py = p[1] - a[1];
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

const HIGHWAYS =
  'primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|cycleway|path|track|steps|primary_link|secondary_link|tertiary_link';

/** Fetch streets from Overpass inside a bounding box [west, south, east, north]. */
export async function fetchStreets(bbox: [number, number, number, number]): Promise<StreetNetwork> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];way["highway"~"^(${HIGHWAYS})$"](${s},${w},${n},${e});out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass failed (${res.status})`);
  const data = (await res.json()) as { elements: { geometry?: { lat: number; lon: number }[] }[] };
  const lines = data.elements
    .filter((el) => el.geometry && el.geometry.length > 1)
    .map((el) => el.geometry!.map((g) => [g.lon, g.lat] as LngLat));
  return new StreetNetwork(lines);
}
