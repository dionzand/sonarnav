import { NavState } from '../core/navigator';
import { MIN_TURN_ANGLE, Profile } from '../core/route';

export type Timbre = OscillatorType;
export type PanMode = 'binaural' | 'hrtf' | 'stereo';

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
  /**
   * binaural: time delay + level + head-shadow filtering per ear (strongest left/right).
   * hrtf: the browser's 3D model (some front/back cues). stereo: plain panning.
   */
  panMode: PanMode;
  /** Exaggerates angles so small deviations already sound clearly to one side (1 = true angle). */
  directionEmphasis: number;
  /** Start the turn preview this many metres before a turn. */
  turnWarn: Record<Profile, number>;
  /** Ambient background (pad + breeze) level, 0 = off. Ambient style only. */
  soundscape: number;
  /** A soft airy layer that always comes from the direction to go. */
  breeze: boolean;
  /** "Keep straight" cues at junctions without a turn: never, only at easy-to-miss forks, or always. */
  junctions: 'off' | 'forks' | 'all';
}

export const DEFAULT_AUDIO: AudioSettings = {
  style: 'ambient',
  volume: 0.6,
  deadZone: 10,
  silentWhenAligned: false,
  rate: 1,
  basePitch: 440,
  panMode: 'binaural',
  directionEmphasis: 1.6,
  turnWarn: { foot: 30, bike: 60 },
  soundscape: 0.5,
  breeze: true,
  junctions: 'forks',
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
    breezeAzimuth: behind ? (state.relBearing >= 0 ? 90 : -90) : emphasize(state.relBearing, s.directionEmphasis),
    breezePan: behind ? (state.relBearing >= 0 ? 1 : -1) : panFor(emphasize(state.relBearing, s.directionEmphasis)),
    // Barely there when on course, clearly present when you need to turn.
    breezeLevel: !s.breeze || state.arrived ? 0 : 0.15 + 0.85 * off,
  };
}

/** One sound event produced by a scheme. */
export interface Cue {
  kind: 'beep' | 'tick' | 'behind' | 'chirp' | 'straight';
  /** 'straight': how many equal notes (3 at a fork). */
  repeats?: number;
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

/**
 * Exaggerate a frontal angle so small deviations already sound clearly sideways
 * (e.g. ×1.6: 20° sounds like 32°). Angles behind you are left alone.
 */
export function emphasize(angle: number, emphasis: number): number {
  if (Math.abs(angle) > 90) return angle;
  return Math.max(-90, Math.min(90, angle * emphasis));
}

// Major pentatonic steps (semitones): every note stays consonant with the others.
const PENTATONIC_UP = [0, 2, 4, 7, 9, 12];
const PENTATONIC_DOWN = [0, 3, 5, 8, 10, 12];

const nearest = (steps: number[], x: number) =>
  steps.reduce((best, s) => (Math.abs(s - x) < Math.abs(best - x) ? s : best));

/**
 * Like a piano keyboard: on course is the base note; the further you need to go RIGHT
 * the HIGHER the note (up to an octave at 90°), and LEFT goes LOWER. With `scale`,
 * pitches step through pentatonic notes so it stays musical.
 */
export function pitchFor(angle: number, base: number, scale = false): number {
  const semis = (Math.min(90, Math.abs(angle)) / 90) * 12;
  const up = angle >= 0;
  const step = scale ? nearest(up ? PENTATONIC_UP : PENTATONIC_DOWN, semis) : semis;
  return base * Math.pow(2, (up ? step : -step) / 12);
}

/** Ambient style breathes slower than classic beeps. */
function pace(s: AudioSettings): number {
  return s.rate / (s.style === 'ambient' ? 1.6 : 1);
}

export function isBehind(angle: number): boolean {
  return Math.abs(angle) > 90;
}

/** Turn-cue repeat interval (s): when first announced → right at the corner, before `rate`. */
const TURN_INTERVAL = { ambient: [2.6, 0.3], classic: [1.3, 0.15] } as const;

/** Repeat interval for a turn cue: shrinks geometrically, so it accelerates towards the corner. */
export function turnInterval(closeness: number, style: AudioSettings['style'], rate = 1): number {
  const [far, near] = TURN_INTERVAL[style];
  return (far * Math.pow(near / far, Math.min(1, Math.max(0, closeness)))) / rate;
}

/**
 * Turn-preview cue, built like a musical climax towards the corner:
 * - rhythm: accelerates geometrically (slow pulses → rapid fire at the corner)
 * - pitch: climbs a pentatonic ladder as you get closer
 * - volume: swells from quiet to full
 * - shape: two notes moving from centre towards the turn's real angle, stepping
 *   UP for a right turn and DOWN for a left turn (a fifth instead of a fourth when sharp)
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
  const sharp = Math.abs(next.angle) > 120;
  const right = next.angle > 0;
  // Ambient starts a fifth below the base note, so it sits under the guidance chimes.
  const start = s.basePitch * (s.style === 'ambient' ? 0.75 : 1.5);
  const rise = PENTATONIC_UP[Math.min(3, Math.floor(closeness * 4))]; // 0, 2, 4, 7 semitones
  const f = start * Math.pow(2, rise / 12);
  const leap = sharp ? 1.5 : 1.335;
  const azimuth = emphasize(next.angle, s.directionEmphasis);
  return {
    kind: 'chirp',
    azimuth,
    pan: panFor(azimuth),
    freq: f,
    freq2: right ? f * leap : f / leap,
    timbre: 'triangle',
    // Notes get shorter as the rhythm speeds up, so it doesn't turn to mush.
    duration: 0.16 - 0.06 * closeness,
    // Loudness grows with closeness (slightly curved so the last metres stand out).
    gain: 0.18 + 0.45 * Math.pow(closeness, 1.3),
    interval: turnInterval(closeness, s.style, s.rate),
  };
}

/** Start the "keep straight" cue this far before a junction (m). */
export const JUNCTION_WARN: Record<Profile, number> = { foot: 15, bike: 30 };

/**
 * "Keep straight" at a junction the route passes through: equal notes from straight ahead
 * (on the piano metaphor: up = right, down = left, level = straight on). Three notes and a
 * little louder at a fork, where a neighbouring branch is easy to take by mistake.
 */
export function junctionCue(state: NavState, s: AudioSettings, profile: Profile): Cue | null {
  const j = state.junction;
  if (s.junctions === 'off' || !j || state.offRoute || state.arrived || isBehind(state.relBearing)) return null;
  if (s.junctions === 'forks' && !j.fork) return null;
  if (state.distanceToJunction > JUNCTION_WARN[profile] || state.distanceToJunction < 0) return null;
  // A turn coming up right after this junction already has the floor.
  if (state.next && state.distanceToNext <= s.turnWarn[profile] && state.distanceToNext < state.distanceToJunction + 20) return null;
  const f = s.basePitch * (s.style === 'ambient' ? 0.75 : 1.5);
  return {
    kind: 'straight',
    repeats: j.fork ? 3 : 2,
    azimuth: 0,
    pan: 0,
    freq: f,
    freq2: f,
    timbre: 'triangle',
    duration: 0.14,
    gain: j.fork ? 0.45 : 0.3,
    interval: (s.style === 'ambient' ? 2.2 : 1.2) / s.rate,
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
      azimuth: r >= 0 ? 90 : -90,
      pan: r >= 0 ? 1 : -1,
      freq: s.basePitch / 4,
      timbre: 'sawtooth',
      duration: 0.18,
      gain: 0.35,
      interval: 0.45 / pace(s),
    };
  }
  const az = emphasize(r, s.directionEmphasis);
  if (a <= s.deadZone && !state.offRoute) {
    if (s.silentWhenAligned) return { ...silent(), interval: 0.25 };
    return {
      kind: 'tick',
      azimuth: az,
      pan: panFor(az),
      freq: s.basePitch,
      timbre: 'sine',
      duration: 0.035,
      gain: 0.25,
      interval: 1.6 / pace(s),
    };
  }
  return {
    kind: 'beep',
    azimuth: az,
    pan: panFor(az),
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
