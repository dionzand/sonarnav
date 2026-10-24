import { LngLat, angleDiff, bearing, cumulativeDistances, pointAlong, projectOnLine } from './geo';

export type Profile = 'foot' | 'bike';

export interface Maneuver {
  /** Distance from route start (m). */
  along: number;
  location: LngLat;
  /** Signed turn angle in degrees, geometry-derived. +right / -left, ±180 = U-turn. */
  angle: number;
  /** Router's maneuver type (turn, fork, roundabout, ...), informational only. */
  type: string;
  /** Street name you turn onto, if known. */
  name: string;
}

/**
 * A junction you pass going (roughly) straight while other streets branch off:
 * a spot where you could take a wrong turn although the route has no turn there.
 */
export interface Junction {
  along: number;
  location: LngLat;
  /** Other enterable branches, as angles relative to your direction of arrival (+right / -left). */
  branches: number[];
  /** A branch within FORK_ANGLE of the way you should go: easy to take by mistake. */
  fork: boolean;
}

export interface Route {
  profile: Profile;
  geometry: LngLat[];
  cum: number[];
  length: number;
  /** Router estimate in seconds. */
  duration: number;
  maneuvers: Maneuver[];
  junctions: Junction[];
}

/** An intersection as the router reports it (OSRM format). */
export interface RawIntersection {
  location: LngLat;
  /** Bearing of every road at the intersection, pointing away from it. */
  bearings: number[];
  /** Whether each road may be entered. */
  entry: boolean[];
  /** Index of the road you arrive on (absent at the start). */
  in?: number;
  /** Index of the road you leave by (absent at the end). */
  out?: number;
}

export interface RawStep {
  location: LngLat;
  type: string;
  name: string;
  intersections?: RawIntersection[];
}

/** A branch within this angle of your way out makes a junction a "fork". */
export const FORK_ANGLE = 50;
/** Junctions this close to a turn are covered by the turn cue. */
const JUNCTION_NEAR_TURN = 12;

/** Ignore "turns" gentler than this — the beacon handles them on its own. */
export const MIN_TURN_ANGLE = 20;

/** Bearing measured over a short window so tiny geometry kinks don't skew the angle. */
const ANGLE_WINDOW = 12;

/** Signed turn angle at distance `along`, from the geometry around it. */
export function turnAngleAt(line: LngLat[], cum: number[], along: number): number {
  const at = pointAlong(line, cum, along).point;
  const before = pointAlong(line, cum, along - ANGLE_WINDOW).point;
  const after = pointAlong(line, cum, along + ANGLE_WINDOW).point;
  if (before[0] === at[0] && before[1] === at[1]) return 0;
  if (after[0] === at[0] && after[1] === at[1]) return 0;
  return angleDiff(bearing(before, at), bearing(at, after));
}

export function buildRoute(
  profile: Profile,
  geometry: LngLat[],
  steps: RawStep[],
  duration: number,
): Route {
  const cum = cumulativeDistances(geometry);
  const length = cum[cum.length - 1];
  const maneuvers: Maneuver[] = [];
  let searchFrom = 0;
  for (const step of steps) {
    if (step.type === 'depart' || step.type === 'arrive') continue;
    const proj = projectOnLine(step.location, geometry, cum, searchFrom);
    searchFrom = proj.segment;
    const angle = turnAngleAt(geometry, cum, proj.along);
    if (Math.abs(angle) < MIN_TURN_ANGLE) continue;
    maneuvers.push({ along: proj.along, location: proj.point, angle, type: step.type, name: step.name });
  }
  const junctions = findJunctions(geometry, cum, steps, maneuvers);
  return { profile, geometry, cum, length, duration, maneuvers, junctions };
}

/** Intersections passed (nearly) straight that have other ways to go. */
function findJunctions(geometry: LngLat[], cum: number[], steps: RawStep[], maneuvers: Maneuver[]): Junction[] {
  const out: Junction[] = [];
  let searchFrom = 0;
  for (const step of steps) {
    for (const x of step.intersections ?? []) {
      if (x.in === undefined || x.out === undefined) continue;
      const arrival = (x.bearings[x.in] + 180) % 360;
      const way = x.bearings[x.out];
      const others = x.bearings.filter((_, i) => i !== x.in && i !== x.out && x.entry[i]);
      if (!others.length) continue;
      const proj = projectOnLine(x.location, geometry, cum, searchFrom);
      searchFrom = proj.segment;
      // A real turn here gets the turn cue instead.
      if (Math.abs(angleDiff(arrival, way)) >= MIN_TURN_ANGLE) continue;
      if (Math.abs(turnAngleAt(geometry, cum, proj.along)) >= MIN_TURN_ANGLE) continue;
      if (maneuvers.some((m) => Math.abs(m.along - proj.along) < JUNCTION_NEAR_TURN)) continue;
      out.push({
        along: proj.along,
        location: proj.point,
        branches: others.map((b) => angleDiff(arrival, b)),
        fork: others.some((b) => Math.abs(angleDiff(way, b)) < FORK_ANGLE),
      });
    }
  }
  return out.sort((a, b) => a.along - b.along);
}

/** Plain-language description of a turn angle, used for speech and the HUD. */
export function describeAngle(angle: number): string {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'right' : 'left';
  if (a < 20) return 'straight on';
  if (a < 50) return `slight ${side}`;
  if (a < 120) return side;
  if (a < 160) return `sharp ${side}`;
  return 'U-turn';
}
