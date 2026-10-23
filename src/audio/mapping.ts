import { NavState } from '../core/navigator';
import { MIN_TURN_ANGLE, Profile } from '../core/route';

export type Timbre = OscillatorType;

export interface AudioSettings {
  /** Ambient: soft chimes with reverb, pentatonic pitches, calmer pace. Classic: crisp beeps. */
  style: 'ambient' | 'classic';
  volume: number; // 0..1
  /** ± degrees treated as "on course". */
  deadZone: number;
  /** Inside the dead zone: soft heartbeat tick (false) or complete silence (true). */
  silentWhenAligned: boolean;
  /** Multiplies all beep rates. 1 = default. */
  rate: number;
  /** Pitch (Hz) of a perfectly aligned beep. */
  basePitch: number;
  /** HRTF gives real front/back cues on headphones; stereo is plain left/right panning. */
  panMode: 'hrtf' | 'stereo';
  /** Start the turn preview this many metres before a turn. */
  turnWarn: Record<Profile, number>;
}

export const DEFAULT_AUDIO: AudioSettings = {
  style: 'ambient',
  volume: 0.6,
  deadZone: 10,
  silentWhenAligned: false,
  rate: 1,
  basePitch: 440,
  panMode: 'stereo',
  turnWarn: { foot: 20, bike: 50 },
};

/** One sound event produced by a scheme. */
export interface Cue {
  kind: 'beep' | 'tick' | 'behind' | 'chirp';
  /** Direction, degrees: 0 ahead, +90 right, -90 left, ±180 behind. Used by HRTF. */
  azimuth: number;
  /** Stereo pan -1..1, used in stereo mode. */
  pan: number;
  freq: number;
  /** Chirps glide from freq to freq2. */
  freq2?: number;
  timbre: Timbre;
  duration: number;
  gain: number;
  /** Seconds until this stream's next cue. */
  interval: number;
}

/** -90..+90° maps linearly to full left..right; anything further back stays fully on that side. */
export function panFor(angle: number): number {
  return Math.max(-1, Math.min(1, angle / 90));
}

// Major pentatonic, descending from the base note: every step stays consonant.
const PENTATONIC_DOWN = [0, 3, 5, 8, 10, 12];

/**
 * Pitch falls one octave between dead-ahead and 90° off. With `scale`, it steps
 * through pentatonic notes instead of sliding, so it sounds musical rather than alarming.
 */
export function pitchFor(angle: number, base: number, scale = false): number {
  const semis = (Math.min(90, Math.abs(angle)) / 90) * 12;
  const step = scale
    ? PENTATONIC_DOWN.reduce((best, s) => (Math.abs(s - semis) < Math.abs(best - semis) ? s : best))
    : semis;
  return base * Math.pow(2, -step / 12);
}

/** Ambient style breathes slower than classic beeps. */
function pace(s: AudioSettings): number {
  return s.rate / (s.style === 'ambient' ? 1.6 : 1);
}

export function isBehind(angle: number): boolean {
  return Math.abs(angle) > 90;
}

/** Turn-preview chirp: panned at the real turn angle, repeating faster as you close in. */
export function turnPreview(state: NavState, s: AudioSettings, profile: Profile): Cue | null {
  const next = state.next;
  if (!next || state.offRoute || state.arrived) return null;
  // Facing away from the route: first turn around; a turn preview would only confuse.
  if (isBehind(state.relBearing)) return null;
  if (Math.abs(next.angle) < MIN_TURN_ANGLE) return null;
  const warn = s.turnWarn[profile];
  if (state.distanceToNext > warn || state.distanceToNext < 0) return null;
  const closeness = 1 - state.distanceToNext / warn; // 0 at warn distance → 1 at the turn
  const interval = (1.4 - 1.1 * closeness) / pace(s); // 1.4 s → 0.3 s (classic)
  const sharp = Math.abs(next.angle) > 120;
  const f = s.basePitch * 1.5;
  return {
    kind: 'chirp',
    azimuth: next.angle,
    pan: panFor(next.angle),
    freq: f,
    // Sharp turns and U-turns glide down a fifth; normal turns step up a fourth.
    freq2: sharp ? f / 1.5 : f * 1.335,
    timbre: 'triangle',
    duration: 0.16,
    gain: 0.55,
    interval,
  };
}

/** Directional beep toward the look-ahead beacon. */
export function beaconBeep(state: NavState, s: AudioSettings): Cue | null {
  if (state.arrived) return null;
  const r = state.relBearing;
  const a = Math.abs(r);
  if (isBehind(r)) {
    // Low and buzzy, fully on the side you should turn towards.
    return {
      kind: 'behind',
      azimuth: r,
      pan: r >= 0 ? 1 : -1,
      freq: s.basePitch / 4,
      timbre: 'sawtooth',
      duration: 0.18,
      gain: 0.35,
      interval: 0.45 / pace(s),
    };
  }
  if (a <= s.deadZone && !state.offRoute) {
    if (s.silentWhenAligned) return { ...silent(), interval: 0.25 };
    return {
      kind: 'tick',
      azimuth: r,
      pan: panFor(r),
      freq: s.basePitch,
      timbre: 'sine',
      duration: 0.035,
      gain: 0.25,
      interval: 1.6 / pace(s),
    };
  }
  return {
    kind: 'beep',
    azimuth: r,
    pan: panFor(r),
    freq: pitchFor(r, s.basePitch, s.style === 'ambient'),
    // A square wave tells you you're off the route while still pointing back to it.
    timbre: state.offRoute ? 'square' : 'sine',
    duration: 0.09,
    gain: state.offRoute ? 0.3 : 0.5,
    // More urgent the further off you are.
    interval: (0.75 - 0.4 * Math.min(1, a / 90)) / pace(s),
  };
}

/** A zero-gain placeholder so a stream can poll again without making a sound. */
export function silent(): Cue {
  return { kind: 'tick', azimuth: 0, pan: 0, freq: 0, timbre: 'sine', duration: 0, gain: 0, interval: 0.25 };
}
