import { LngLat } from '../core/geo';

export interface PositionFix {
  position: LngLat;
  /** Degrees from north. On a phone: compass when walking, GPS course when cycling. */
  heading: number;
  /** m/s */
  speed: number;
  /** Seconds, monotonic. */
  time: number;
}

/** Anything that can tell the navigator where you are: the keyboard simulator, real GPS, a GPX replay. */
export interface PositionSource {
  current(time: number): PositionFix | null;
}
