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
  /** Ambient background (pad + breeze) level, 0 = off. Ambient style only. */
  soundscape: number;
  /** A soft airy layer that always comes from the direction to go. */
  breeze: boolean;
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
  soundscape: 0.5,
  breeze: true,
};

/** Target state of the continuous background soundscape. */
export interface SoundscapeParams {
  /** Pad level 0..1 (before the user's soundscape setting). */
  level: number;
  /** 0 = warm and resolved (on route) … 1 = suspended chord (off route). */
  tension: number;
  /** Pad low-pass cutoff (Hz): open when on course, darker when off. */
  cutoff: number;
  /** Breathing rate of the pad (Hz), quicker when you move faster. */
  breath: number;
  breezeAzimuth: number;
  breezePan: number;
  breezeLevel: number;
}

/** No route: a quiet idle bed so the app still feels alive. */
export const IDLE_SOUNDSCAPE: SoundscapeParams = {
  level: 0.45,
  tension: 0,
  cutoff: 700,
  breath: 0.05,
  breezeAzimuth: 0,
  breezePan: 0,
  breezeLevel: 0,
};

export function soundscapeFor(state: NavState | null, s: AudioSettings): SoundscapeParams {
  if (!state) return IDLE_SOUNDSCAPE;
  const off = Math.min(1, Math.abs(state.relBearing) / 120);
  const behind = isBehind(state.relBearing);
  return {
    // After arrival the bed settles down and stays resolved.
    level: state.arrived ? 0.35 : 1,
    tension: state.offRoute ? 1 : 0,
    cutoff: 1400 - 900 * off,
    breath: 0.05 + Math.min(0.2, state.speed * 0.025),
    breezeAzimuth: state.relBearing,
    breezePan: behind ? (state.relBearing >= 0 ? 1 : -1) : panFor(state.relBearing),
    // Barely there when on course, clearly present when you need to turn.
    breezeLevel: !s.breeze || state.arrived ? 0 : 0.15 + 0.85 * off,
  };
}

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

/** Turn-cue repeat interval (s) when first announced → right at the corner, before `rate`. */
const TURN_INTERVAL = { ambient: [3.2, 1.2], classic: [1.4, 0.3] } as const;

/**
 * Turn-preview cue: panned at the real turn angle. Distance is told twice:
 * it repeats faster and swells from quiet to full volume as you close in.
 */
export function turnPreview(state: NavState, s: AudioSettings, profile: Profile): Cue | null {
  const next = state.next;
  if (!next || state.offRoute || state.arrived) return null;
  // Facing away from the route: first turn around; a turn preview would only confuse.
  if (isBehind(state.relBearing)) return null;
  if (Math.abs(next.angle) < MIN_TURN_ANGLE) return null;
  const warn = s.turnWarn[profile];
  if (state.distanceToNext > warn || state.distanceToNext < 0) return null;
  const closeness = 1 - state.distanceToNext / warn; // 0 at warn distance → 1 at the turn
  const [far, near] = TURN_INTERVAL[s.style];
  const interval = (far - (far - near) * closeness) / s.rate;
  const sharp = Math.abs(next.angle) > 120;
  // Ambient: a fifth below the base note, so it sits under the guidance chimes.
  const f = s.basePitch * (s.style === 'ambient' ? 0.75 : 1.5);
  return {
    kind: 'chirp',
    azimuth: next.angle,
    pan: panFor(next.angle),
    freq: f,
    // Sharp turns and U-turns step down a fifth; normal turns step up a fourth.
    freq2: sharp ? f / 1.5 : f * 1.335,
    timbre: 'triangle',
    duration: 0.16,
    // Loudness grows with closeness (slightly curved so the last metres stand out).
    gain: 0.18 + 0.45 * Math.pow(closeness, 1.3),
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
