import { LngLat, angleDiff, bearing, distance, normalize360 } from '../core/geo';
import { PositionFix, PositionSource } from './provider';

/**
 * Where the heading comes from on a real phone:
 * - compass: the way the phone's top points (handheld or handlebar-mounted)
 * - course: GPS direction of travel (phone in a pocket; needs movement)
 * - auto: GPS course when moving fast enough, compass otherwise
 */
export type HeadingSource = 'auto' | 'compass' | 'course';

/** Above this speed (m/s, ≈ 7 km/h) GPS course is more reliable than a wobbly compass. */
const COURSE_MIN_SPEED = 2;

interface OrientationEventIOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/** Real GPS + compass via the browser. Requires HTTPS (or localhost). */
export class LiveGps implements PositionSource {
  headingSource: HeadingSource = 'auto';
  running = false;
  accuracy: number | null = null;
  compass: number | null = null;
  course: number | null = null;
  usedSource: 'compass' | 'course' | null = null;
  error: string | null = null;

  private position: LngLat | null = null;
  private speed = 0;
  private lastFixTime = 0;
  private prevForCourse: LngLat | null = null;
  private heading = 0;
  private watchId: number | null = null;

  /** Call from a user gesture (tap): iOS only grants compass permission then. */
  async start(): Promise<void> {
    if (this.running) return;
    if (!('geolocation' in navigator)) throw new Error('This browser has no GPS access.');
    if (!window.isSecureContext) throw new Error('GPS needs HTTPS. Open the deployed https:// URL.');

    // iOS 13+: explicit permission for orientation/compass.
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission().catch(() => 'denied' as const);
      if (res !== 'granted') this.error = 'Compass permission denied: heading will come from GPS movement only.';
    }
    // iOS gives webkitCompassHeading on 'deviceorientation'; Android gives absolute alpha.
    window.addEventListener('deviceorientation', this.onOrientation);
    window.addEventListener('deviceorientationabsolute', this.onOrientation as EventListener);

    await new Promise<void>((resolve, reject) => {
      let first = true;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.onPosition(pos);
          if (first) {
            first = false;
            resolve();
          }
        },
        (err) => {
          this.error = err.message || 'Location unavailable';
          if (first) {
            first = false;
            reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location permission denied.' : this.error));
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    });
    this.running = true;
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('deviceorientationabsolute', this.onOrientation as EventListener);
    this.running = false;
  }

  private onOrientation = (e: OrientationEventIOS): void => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      h = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
      h = 360 - e.alpha;
    }
    if (h === null) return;
    // Compass heading is relative to the device's top edge; correct for landscape.
    h = normalize360(h + (screen.orientation?.angle ?? 0));
    // Smooth the jitter (circular low-pass).
    this.compass = this.compass === null ? h : normalize360(this.compass + 0.25 * angleDiff(this.compass, h));
  };

  private onPosition(pos: GeolocationPosition): void {
    const c = pos.coords;
    const p: LngLat = [c.longitude, c.latitude];
    this.position = p;
    this.accuracy = c.accuracy;
    this.lastFixTime = pos.timestamp;
    this.speed = c.speed !== null && c.speed >= 0 ? c.speed : this.speed;
    if (c.heading !== null && !Number.isNaN(c.heading) && this.speed > 0.5) {
      this.course = c.heading;
    } else if (this.prevForCourse && distance(this.prevForCourse, p) > Math.max(6, c.accuracy * 0.5)) {
      // No course from the device: derive it from movement.
      this.course = bearing(this.prevForCourse, p);
    }
    if (!this.prevForCourse || distance(this.prevForCourse, p) > 6) this.prevForCourse = p;
  }

  /** Seconds since the last GPS fix. */
  get fixAge(): number {
    return this.lastFixTime ? (Date.now() - this.lastFixTime) / 1000 : Infinity;
  }

  current(time: number): PositionFix | null {
    if (!this.position) return null;
    const useCourse =
      this.course !== null &&
      (this.headingSource === 'course' ||
        (this.headingSource === 'auto' && (this.speed >= COURSE_MIN_SPEED || this.compass === null)));
    if (useCourse) {
      this.heading = this.course!;
      this.usedSource = 'course';
    } else if (this.compass !== null && this.headingSource !== 'course') {
      this.heading = this.compass;
      this.usedSource = 'compass';
    }
    return { position: this.position, heading: this.heading, speed: this.speed, time };
  }
}
