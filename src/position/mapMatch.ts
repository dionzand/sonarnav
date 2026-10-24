import { LngLat, angleDiff, cumulativeDistances, distance, projectOnLine } from '../core/geo';
import { PositionFix } from './provider';
import { Candidate, StreetNetwork } from './streets';

/** Never snap further than this (m), however poor the GPS. */
const MAX_RADIUS = 35;
/** Below this speed (m/s) the GPS course is unreliable: ignore it for scoring and heading. */
const MOVING = 0.8;
/** Score weights (lower score = better candidate). */
const HEADING_WEIGHT = 2.5;
/** Transition: penalty per metre that the network path is longer than the distance moved… */
const DETOUR_SCALE = 1 / 12;
/** …capped here (also used when there's no path at all, e.g. a parallel street). */
const MAX_TRANSITION = 3;
const ROUTE_BONUS = 1.0;
/** A street point within this distance (m) of the route line counts as "on the route". */
const ON_ROUTE = 4;

export interface MatchResult extends PositionFix {
  /** The unmatched GPS position (for display). */
  raw: LngLat;
  matched: boolean;
}

/**
 * Snaps noisy GPS fixes onto the street network, one fix at a time.
 *
 * Each nearby street segment is scored on:
 * - distance, relative to the GPS accuracy (a Gaussian measurement model);
 * - direction: does the street run the way you're moving?
 * - continuity: the walk over the network from the previous match should be about as
 *   long as the distance actually moved. Jumping to a parallel street means a long
 *   detour via a junction, so it's penalized;
 * - the planned route gets a small bonus (you're probably on it).
 * The best candidate wins. This is the greedy core of HMM map-matching, which is
 * enough to stop the classic "dot jumps to the street next door" problem.
 */
export class MapMatcher {
  private prev: { segment: number; point: LngLat; raw: LngLat } | null = null;
  private routeCum: number[] | null;

  constructor(
    private network: StreetNetwork,
    private route?: LngLat[],
  ) {
    this.routeCum = route && route.length > 1 ? cumulativeDistances(route) : null;
  }

  /** Does this street point lie on the planned route? */
  private onRoute(p: LngLat): boolean {
    if (!this.route || !this.routeCum) return false;
    return projectOnLine(p, this.route, this.routeCum).distance < ON_ROUTE;
  }

  reset(): void {
    this.prev = null;
  }

  match(fix: PositionFix): MatchResult {
    const raw = fix.position;
    const accuracy = Math.max(3, fix.accuracy ?? 5);
    const sigma = Math.max(4, accuracy / 2);
    const radius = Math.min(MAX_RADIUS, Math.max(12, accuracy * 2));
    const cands = this.network.candidates(raw, radius);
    if (!cands.length) {
      this.prev = null;
      return { ...fix, raw, matched: false };
    }

    const moving = fix.speed >= MOVING;
    const prev = this.prev;
    // As in HMM map-matching: the straight-line distance between consecutive raw fixes.
    const moved = prev ? distance(prev.raw, raw) : 0;
    // Any path longer than this already gets the maximum penalty, so stop searching there.
    const limit = moved + MAX_TRANSITION / DETOUR_SCALE + 10;

    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      let score = (c.distance * c.distance) / (2 * sigma * sigma);
      if (moving) {
        // Streets are two-way: compare against the closer of the two directions.
        const diff = Math.abs(angleDiff(fix.heading, c.bearing));
        const off = Math.min(diff, 180 - diff);
        score += HEADING_WEIGHT * (1 - Math.cos((off * Math.PI) / 180));
      }
      if (prev) {
        const net = this.network.networkDistance(prev.segment, prev.point, c.segment, c.point, limit);
        score += Math.min(MAX_TRANSITION, Math.abs(net - moved) * DETOUR_SCALE);
      }
      if (this.onRoute(c.point)) score -= ROUTE_BONUS;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    const m = best!;
    this.prev = { segment: m.segment, point: m.point, raw };

    // Moving along a street: its direction is a steadier heading than the raw GPS course.
    let heading = fix.heading;
    if (moving) {
      const forward = Math.abs(angleDiff(fix.heading, m.bearing)) <= 90 ? m.bearing : (m.bearing + 180) % 360;
      if (Math.abs(angleDiff(fix.heading, forward)) < 35) heading = forward;
    }
    return { ...fix, position: m.point, heading, raw, matched: true };
  }
}
