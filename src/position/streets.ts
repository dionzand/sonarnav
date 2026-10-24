import { LngLat, bearing, distance } from '../core/geo';

export interface Candidate {
  /** Segment index. */
  segment: number;
  point: LngLat;
  distance: number;
  /** Bearing of the segment (a → b); streets are two-way, so also consider +180. */
  bearing: number;
}

// Endpoints are compared by rounded coordinates (~1 cm): OSM ways share nodes at junctions.
const nodeKey = (p: LngLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Walkable/cyclable street segments with a coarse grid index for fast nearest-segment lookup. */
export class StreetNetwork {
  private segments: [LngLat, LngLat][] = [];
  private grid = new Map<string, number[]>();
  /** Segments touching each node, for connectivity. */
  private byNode = new Map<string, number[]>();
  private static CELL = 0.0005; // ≈ 35–55 m

  constructor(readonly lines: LngLat[][]) {
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const idx = this.segments.push([line[i], line[i + 1]]) - 1;
        for (const key of this.cellsFor(line[i], line[i + 1])) {
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(idx);
          else this.grid.set(key, [idx]);
        }
        for (const p of [line[i], line[i + 1]]) {
          const k = nodeKey(p);
          const list = this.byNode.get(k);
          if (list) list.push(idx);
          else this.byNode.set(k, [idx]);
        }
      }
    }
  }

  get size(): number {
    return this.segments.length;
  }

  /** Every segment within `radius` metres of p (radius up to ~35 m). */
  candidates(p: LngLat, radius: number): Candidate[] {
    const C = StreetNetwork.CELL;
    const cx = Math.floor(p[0] / C);
    const cy = Math.floor(p[1] / C);
    const seen = new Set<number>();
    const out: Candidate[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const idx of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const [a, b] = this.segments[idx];
          const q = closestOnSegment(p, a, b);
          const d = distance(p, q);
          if (d <= radius) out.push({ segment: idx, point: q, distance: d, bearing: bearing(a, b) });
        }
      }
    }
    return out;
  }

  segment(i: number): [LngLat, LngLat] {
    return this.segments[i];
  }

  /** Segments that start or end at node p. */
  segmentsAt(p: LngLat): number[] {
    return this.byNode.get(nodeKey(p)) ?? [];
  }

  /**
   * Walking distance over the network from `from` (a point on segment `fromSeg`) to `to`
   * (a point on segment `toSeg`), or Infinity if it's longer than `limit` metres.
   */
  networkDistance(fromSeg: number, from: LngLat, toSeg: number, to: LngLat, limit: number): number {
    if (fromSeg === toSeg) return distance(from, to);
    // Dijkstra over nodes, seeded with both ends of the starting segment.
    const dist = new Map<string, number>();
    const queue: [number, LngLat][] = [];
    for (const p of this.segments[fromSeg]) {
      const d = distance(from, p);
      dist.set(nodeKey(p), d);
      queue.push([d, p]);
    }
    const [ta, tb] = this.segments[toSeg];
    const targets = new Map([
      [nodeKey(ta), distance(ta, to)],
      [nodeKey(tb), distance(tb, to)],
    ]);
    let best = Infinity;
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [d, p] = queue.shift()!;
      if (d > limit || d >= best) break;
      const k = nodeKey(p);
      if (d > (dist.get(k) ?? Infinity)) continue;
      const tail = targets.get(k);
      if (tail !== undefined) best = Math.min(best, d + tail);
      for (const s of this.byNode.get(k) ?? []) {
        const [a, b] = this.segments[s];
        const other = nodeKey(a) === k ? b : a;
        const nd = d + distance(p, other);
        if (nd < (dist.get(nodeKey(other)) ?? Infinity)) {
          dist.set(nodeKey(other), nd);
          queue.push([nd, other]);
        }
      }
    }
    return best <= limit ? best : Infinity;
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
