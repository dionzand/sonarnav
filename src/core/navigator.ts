import { LngLat, angleDiff, bearing, distance, pointAlong, projectOnLine } from './geo';
import { Junction, Maneuver, Route } from './route';

export interface NavSettings {
  /** Minimum look-ahead distance (m). */
  lookaheadMin: number;
  /** Look-ahead grows with speed: speed (m/s) × this many seconds. */
  lookaheadSeconds: number;
  /** Keep the beacon on the next corner until you're this close to it (m). 0 disables. */
  cornerCommit: number;
  /** Cross-track distance (m) beyond which you count as off-route. */
  offRouteDistance: number;
  /** ...for at least this long (s). */
  offRouteDelay: number;
  arriveRadius: number;
}

export const DEFAULT_NAV: Record<'foot' | 'bike', NavSettings> = {
  foot: { lookaheadMin: 20, lookaheadSeconds: 8, cornerCommit: 6, offRouteDistance: 30, offRouteDelay: 5, arriveRadius: 10 },
  bike: { lookaheadMin: 25, lookaheadSeconds: 4, cornerCommit: 10, offRouteDistance: 35, offRouteDelay: 3, arriveRadius: 15 },
};

/**
 * Within this distance of the route (or the GPS accuracy, if larger) you count as "on" it:
 * guidance follows the route's own direction instead of aiming from your (noisy) position.
 */
const ON_LINE_TOLERANCE = 8;

/** Circular interpolation between two bearings. */
function lerpBearing(a: number, b: number, t: number): number {
  return (a + angleDiff(a, b) * t + 360) % 360;
}

export type NavEvent = 'offRoute' | 'backOnRoute' | 'arrived' | 'maneuverPassed';

export interface NavState {
  position: LngLat;
  /** Your heading, degrees from north. */
  heading: number;
  speed: number;
  /** Distance along the route of your projected position (m). */
  along: number;
  /** Closest point on the route. */
  snapped: LngLat;
  crossTrack: number;
  remaining: number;
  beacon: LngLat;
  /** Signed angle from your heading to the beacon. +right / -left, ±180 behind. */
  relBearing: number;
  distanceToBeacon: number;
  /** Direction of the route where you are. */
  routeBearing: number;
  next: Maneuver | null;
  distanceToNext: number;
  /** Next junction to pass straight through (see Route.junctions). */
  junction: Junction | null;
  distanceToJunction: number;
  offRoute: boolean;
  arrived: boolean;
  /** Events raised by this update. */
  events: NavEvent[];
}

export class Navigator {
  private along = 0;
  private offRoute = false;
  private offRouteSince: number | null = null;
  private arrived = false;
  private nextIndex = 0;
  private junctionIndex = 0;

  constructor(
    public route: Route,
    public settings: NavSettings,
  ) {}

  setRoute(route: Route): void {
    this.route = route;
    this.along = 0;
    this.offRoute = false;
    this.offRouteSince = null;
    this.arrived = false;
    this.nextIndex = 0;
    this.junctionIndex = 0;
  }

  /**
   * `time` in seconds (monotonic). `accuracy` is the GPS error estimate in metres (0 = exact):
   * the noisier the fix, the more slack before declaring you off-route.
   */
  update(position: LngLat, heading: number, speed: number, time: number, accuracy = 0): NavState {
    const { route } = this;
    // GPS noise mustn't push you "off route": the threshold grows with the reported error.
    const s = { ...this.settings, offRouteDistance: Math.max(this.settings.offRouteDistance, accuracy * 1.5 + 10) };
    const events: NavEvent[] = [];

    // Search a window around the last known progress so self-crossing routes don't
    // make progress jump; fall back to a global search when we've drifted away.
    const [lo, hi] = this.segmentWindow(this.along - 40, this.along + 250);
    let proj = projectOnLine(position, route.geometry, route.cum, lo, hi);
    if (proj.distance > s.offRouteDistance) {
      const global = projectOnLine(position, route.geometry, route.cum);
      if (global.distance < proj.distance - 5) proj = global;
    }
    this.along = proj.along;

    // Off-route with hysteresis: must stay far for offRouteDelay; return at 60 % distance.
    if (!this.offRoute) {
      if (proj.distance > s.offRouteDistance) {
        this.offRouteSince ??= time;
        if (time - this.offRouteSince >= s.offRouteDelay) {
          this.offRoute = true;
          events.push('offRoute');
        }
      } else {
        this.offRouteSince = null;
      }
    } else if (proj.distance < s.offRouteDistance * 0.6) {
      this.offRoute = false;
      this.offRouteSince = null;
      events.push('backOnRoute');
    }

    // Advance past maneuvers we've driven through.
    const ms = route.maneuvers;
    while (this.nextIndex < ms.length && ms[this.nextIndex].along < this.along + 1) {
      this.nextIndex++;
      events.push('maneuverPassed');
    }
    const next = ms[this.nextIndex] ?? null;
    const distanceToNext = next ? next.along - this.along : route.length - this.along;
    const js = route.junctions;
    while (this.junctionIndex < js.length && js[this.junctionIndex].along < this.along + 1) this.junctionIndex++;
    const junction = js[this.junctionIndex] ?? null;
    const distanceToJunction = junction ? junction.along - this.along : Infinity;

    // Beacon: a point ahead along the route. It waits on the next corner until you are
    // within cornerCommit of it, then jumps around the corner — that jump is the turn cue.
    const lookahead = Math.max(s.lookaheadMin, speed * s.lookaheadSeconds);
    let beaconAlong = this.along + lookahead;
    if (next && s.cornerCommit > 0 && distanceToNext > s.cornerCommit) {
      beaconAlong = Math.min(beaconAlong, next.along);
    }
    const beacon = pointAlong(route.geometry, route.cum, beaconAlong).point;
    const distanceToBeacon = distance(position, beacon);
    // Aim: close to the route (within GPS uncertainty) follow the route's own direction,
    // measured from your snapped point, so a few metres of GPS error don't swing the cue.
    // Further away, aim from where you are, which also steers you back onto the route.
    const tol = Math.max(ON_LINE_TOLERANCE, accuracy);
    const fromSnapped = distance(proj.point, beacon) < 0.5 ? null : bearing(proj.point, beacon);
    const fromYou = distanceToBeacon < 0.5 ? null : bearing(position, beacon);
    const w = Math.min(1, Math.max(0, (proj.distance - tol) / tol));
    const aim = fromSnapped === null ? fromYou : fromYou === null ? fromSnapped : lerpBearing(fromSnapped, fromYou, w);
    const relBearing = aim === null ? 0 : angleDiff(heading, aim);

    const seg = proj.segment;
    const routeBearing = bearing(route.geometry[seg], route.geometry[seg + 1] ?? route.geometry[seg]);

    const remaining = Math.max(0, route.length - this.along);
    const toEnd = distance(position, route.geometry[route.geometry.length - 1]);
    if (!this.arrived && toEnd < s.arriveRadius) {
      this.arrived = true;
      events.push('arrived');
    }

    return {
      position,
      heading,
      speed,
      along: this.along,
      snapped: proj.point,
      crossTrack: proj.distance,
      remaining,
      beacon,
      relBearing,
      distanceToBeacon,
      routeBearing,
      next,
      distanceToNext,
      junction,
      distanceToJunction,
      offRoute: this.offRoute,
      arrived: this.arrived,
      events,
    };
  }

  private segmentWindow(fromAlong: number, toAlong: number): [number, number] {
    const cum = this.route.cum;
    let lo = 0;
    while (lo < cum.length - 2 && cum[lo + 1] < fromAlong) lo++;
    let hi = lo;
    while (hi < cum.length - 2 && cum[hi] < toAlong) hi++;
    return [lo, hi];
  }
}
