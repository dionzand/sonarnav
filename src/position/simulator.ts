import { LngLat, angleDiff, bearing, destination, distance, normalize360, projectOnLine } from '../core/geo';
import { Profile, Route } from '../core/route';
import { PositionFix, PositionSource } from './provider';
import { StreetNetwork } from './streets';

export type SnapMode = 'off' | 'route' | 'streets';
export const SNAP_MODES: SnapMode[] = ['off', 'route', 'streets'];

interface Physics {
  maxSpeed: number; // m/s
  accel: number; // m/s²
  turnRate: number; // °/s when you start holding a key
  turnRateMax: number; // °/s after holding for a while
}

const PHYSICS: Record<Profile, Physics> = {
  foot: { maxSpeed: 1.7, accel: 1.2, turnRate: 40, turnRateMax: 140 },
  bike: { maxSpeed: 7, accel: 1.8, turnRate: 30, turnRateMax: 100 },
};

/** Max distance (m) the walker may stray from the line in a snap mode before snapping is dropped. */
const SNAP_RADIUS = 12;

/**
 * Keyboard-driven walker/cyclist. Speed is "cruise control": it holds when you release ↑,
 * so you can concentrate on steering and listening.
 */
export class Simulator implements PositionSource {
  position: LngLat;
  heading = 0;
  speed = 0;
  paused = false;
  profile: Profile = 'bike';
  snapMode: SnapMode = 'off';
  route: Route | null = null;
  streets: StreetNetwork | null = null;

  private keys = new Set<string>();
  private turnHeld = 0;
  private time = 0;

  constructor(start: LngLat) {
    this.position = start;
  }

  get physics(): Physics {
    return PHYSICS[this.profile];
  }

  press(key: 'up' | 'down' | 'left' | 'right'): void {
    this.keys.add(key);
  }

  release(key: 'up' | 'down' | 'left' | 'right'): void {
    this.keys.delete(key);
  }

  releaseAll(): void {
    this.keys.clear();
  }

  teleport(p: LngLat): void {
    this.position = p;
  }

  /** Turn by an exact number of degrees (+ = clockwise). */
  turnBy(deg: number): void {
    this.heading = normalize360(this.heading + deg);
  }

  setHeading(deg: number): void {
    this.heading = normalize360(deg);
  }

  /** Face a point. */
  face(p: LngLat): void {
    this.heading = bearing(this.position, p);
  }

  stop(): void {
    this.speed = 0;
  }

  tick(dt: number): void {
    this.time += dt;
    if (this.paused) return;
    const ph = this.physics;

    const left = this.keys.has('left');
    const right = this.keys.has('right');
    if (left !== right) {
      this.turnHeld += dt;
      // Ramp from the fine rate to the fast rate over ~0.8 s of holding.
      const rate = ph.turnRate + (ph.turnRateMax - ph.turnRate) * Math.min(1, this.turnHeld / 0.8);
      this.turnBy((right ? 1 : -1) * rate * dt);
    } else {
      this.turnHeld = 0;
    }

    if (this.keys.has('up')) this.speed = Math.min(ph.maxSpeed, this.speed + ph.accel * dt);
    if (this.keys.has('down')) this.speed = Math.max(0, this.speed - ph.accel * 2 * dt);
    if (this.speed > ph.maxSpeed) this.speed = ph.maxSpeed; // e.g. after switching bike → foot

    if (this.speed > 0) {
      const step = this.speed * dt;
      const next = destination(this.position, this.heading, step);
      const snapped = this.snap(next);
      // At the dead end of a way (or a gap between ways) snapping pulls you back to the
      // same spot forever; if it cancels most of the forward progress, take the free step.
      const moved = distance(this.position, snapped);
      const progress = moved < 1e-6 ? 0 : moved * Math.cos((angleDiff(this.heading, bearing(this.position, snapped)) * Math.PI) / 180);
      this.position = progress < step * 0.3 ? next : snapped;
    }
  }

  private snap(p: LngLat): LngLat {
    if (this.snapMode === 'route' && this.route) {
      const proj = projectOnLine(p, this.route.geometry, this.route.cum);
      return proj.distance < SNAP_RADIUS ? proj.point : p;
    }
    if (this.snapMode === 'streets' && this.streets) {
      const near = this.streets.nearest(p);
      return near && near.distance < SNAP_RADIUS ? near.point : p;
    }
    return p;
  }

  current(): PositionFix {
    return { position: this.position, heading: this.heading, speed: this.speed, time: this.time };
  }
}
