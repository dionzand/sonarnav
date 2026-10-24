import { NavState } from '../core/navigator';
import { Profile } from '../core/route';
import { AudioSettings, Cue, beaconBeep, emphasize, isBehind, panFor, pitchFor, turnPreview } from './mapping';

/** Parameters for a sustained tone (continuous schemes). */
export interface ToneParams {
  azimuth: number;
  pan: number;
  freq: number;
  gain: number;
  timbre: OscillatorType;
}

/**
 * A cue scheme turns navigation state into sound. It has two independent streams:
 * guidance (where to head now) and maneuver (what's coming up).
 * Add a new scheme here and it shows up in the UI.
 */
export interface CueScheme {
  id: string;
  name: string;
  description: string;
  /** Discrete guidance beeps; omit when using `tone`. */
  guidance?(state: NavState, s: AudioSettings, profile: Profile): Cue | null;
  /** Sustained guidance tone, updated continuously. */
  tone?(state: NavState, s: AudioSettings): ToneParams | null;
  maneuver(state: NavState, s: AudioSettings, profile: Profile): Cue | null;
}

export const SCHEMES: CueScheme[] = [
  {
    id: 'beacon',
    name: 'Beacon',
    description:
      'Notes come from the direction to go. Like a piano: higher note = go right, lower note = go left, ' +
      'and the further off, the bigger the step. A faint droplet means you are on course. ' +
      'A deep, low note means the route is behind you. Before a turn, a two-note cue moves towards the turn ' +
      '(stepping up for right, down for left) and builds up — faster, higher, louder — until the corner.',
    guidance: (st, s) => beaconBeep(st, s),
    maneuver: (st, s, p) => turnPreview(st, s, p),
  },
  {
    id: 'tone',
    name: 'Continuous tone',
    description:
      'One steady tone that follows the direction to go: its position shows the direction, and its pitch rises for right and falls for left. ' +
      'It gets quiet when you are on course. Turn cues work as in Beacon.',
    tone: (st, s) => {
      if (st.arrived) return null;
      const r = st.relBearing;
      const behind = isBehind(r);
      const aligned = Math.abs(r) <= s.deadZone;
      const az = behind ? (r >= 0 ? 90 : -90) : emphasize(r, s.directionEmphasis);
      return {
        azimuth: az,
        pan: panFor(az),
        freq: behind ? s.basePitch / 4 : pitchFor(r, s.basePitch / 2),
        gain: aligned ? 0.06 : behind ? 0.2 : 0.18,
        timbre: behind ? 'sawtooth' : st.offRoute ? 'square' : 'sine',
      };
    },
    maneuver: (st, s, p) => turnPreview(st, s, p),
  },
  {
    id: 'events',
    name: 'Events only',
    description:
      'Silent while you are roughly on course. Notes only start when you drift more than twice the dead zone off, ' +
      'and turn cues sound before each turn.',
    guidance: (st, s) => {
      if (Math.abs(st.relBearing) <= s.deadZone * 2 && !st.offRoute) return null;
      return beaconBeep(st, s);
    },
    maneuver: (st, s, p) => turnPreview(st, s, p),
  },
];
