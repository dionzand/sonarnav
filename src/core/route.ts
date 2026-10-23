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

export interface Route {
  profile: Profile;
  geometry: LngLat[];
  cum: number[];
  length: number;
  /** Router estimate in seconds. */
  duration: number;
  maneuvers: Maneuver[];
}

export interface RawStep {
  location: LngLat;
  type: string;
  name: string;
}

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
  return { profile, geometry, cum, length, duration, maneuvers };
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
