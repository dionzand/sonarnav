import { NavState } from '../core/navigator';
import { Profile } from '../core/route';
import { AudioSettings, Cue, panFor, soundscapeFor } from './mapping';
import { CueScheme, ToneParams } from './schemes';
import { Soundscape } from './soundscape';
import { chime, chirp, noiseBurst, notes, reverbImpulse, spatializer, tone } from './synth';

export type AudioEvent = 'offRoute' | 'backOnRoute' | 'arrived' | 'rerouted' | 'maneuverPassed';

interface Voice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode | PannerNode;
  mode: AudioSettings['panMode'];
}

/** Reverb send level per style: a soft room for ambient, dry for classic. */
const WET = { ambient: 0.32, classic: 0 };

/**
 * Drives the cue scheme from the latest NavState. A 25 ms timer schedules each stream's
 * next cue slightly ahead on the audio clock, so timing stays tight even if frames drop.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything audible goes here: it feeds the master directly and through the reverb. */
  private bus: GainNode | null = null;
  private wet: GainNode | null = null;
  private timer: number | null = null;
  private state: NavState | null = null;
  private nextGuidance = 0;
  private nextManeuver = 0;
  private voice: Voice | null = null;
  private busyUntil = 0; // suppress guidance while an event sound plays
  private lastPlayedKind: Cue['kind'] | null = null;
  private lastPlayedAt = 0;
  private scape: Soundscape | null = null;
  private scapeKey = '';
  private lastScapeUpdate = 0;

  muted = false;
  lastGuidance: Cue | ToneParams | null = null;
  lastManeuver: Cue | null = null;

  constructor(
    public settings: AudioSettings,
    public scheme: CueScheme,
    public profile: () => Profile,
  ) {}

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  private get ambient(): boolean {
    return this.settings.style === 'ambient';
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  async start(): Promise<void> {
    // iOS: a "playback" session keeps sounding with the ringer/silent switch on (Safari 16.4+).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
      this.master = new GainNode(ctx, { gain: this.settings.volume });
      const comp = new DynamicsCompressorNode(ctx, { threshold: -12, ratio: 4 });
      this.master.connect(comp).connect(ctx.destination);
      this.bus = new GainNode(ctx);
      this.bus.connect(this.master);
      this.wet = new GainNode(ctx, { gain: WET[this.settings.style] });
      const reverb = new ConvolverNode(ctx, { buffer: reverbImpulse(ctx, 2.8) });
      this.bus.connect(reverb).connect(this.wet).connect(this.master);
    }
    await this.ctx.resume();
    this.timer ??= window.setInterval(() => this.schedule(), 25);
  }

  setState(state: NavState | null): void {
    this.state = state;
  }

  setScheme(scheme: CueScheme): void {
    this.scheme = scheme;
    this.stopVoice();
    this.nextGuidance = this.nextManeuver = 0;
  }

  setStyle(style: AudioSettings['style']): void {
    this.settings.style = style;
    if (this.ctx && this.wet) this.wet.gain.setTargetAtTime(WET[style], this.ctx.currentTime, 0.1);
  }

  setVolume(v: number): void {
    this.settings.volume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.02);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setVolume(this.settings.volume);
  }

  private schedule(): void {
    const ctx = this.ctx;
    const st = this.state;
    if (!ctx || !this.bus) return;
    const now = ctx.currentTime;
    const ahead = 0.05;
    this.updateSoundscape(st, now);
    if (!st) {
      this.stopVoice();
      this.lastGuidance = this.lastManeuver = null;
      return;
    }
    const s = this.settings;
    const profile = this.profile();

    if (this.scheme.tone) {
      const p = now < this.busyUntil ? null : this.scheme.tone(st, s);
      this.updateVoice(p);
      this.lastGuidance = p;
    } else if (this.scheme.guidance) {
      const due = now + ahead >= this.nextGuidance;
      const cue = now < this.busyUntil ? null : this.scheme.guidance(st, s, profile);
      // Slow cues (e.g. the on-course droplet every few seconds) must not delay news:
      // when the kind of cue changes, play it right away instead of waiting the interval out.
      const changed =
        !!cue && cue.gain > 0 && cue.kind !== this.lastPlayedKind && now - this.lastPlayedAt > 0.35;
      if (due || changed) {
        this.lastGuidance = cue;
        const t = changed && !due ? now + 0.01 : Math.max(now + 0.01, this.nextGuidance);
        if (cue && cue.gain > 0) {
          this.play(cue, t);
          this.lastPlayedKind = cue.kind;
          this.lastPlayedAt = t;
        }
        this.nextGuidance = Math.max(now, changed && !due ? now : this.nextGuidance) + (cue?.interval ?? 0.2);
      }
    }

    if (now + ahead >= this.nextManeuver) {
      const cue = this.scheme.maneuver(st, s, profile);
      this.lastManeuver = cue;
      if (cue) {
        const t = Math.max(now + 0.01, this.nextManeuver);
        this.play(cue, t);
        // Keep the guidance cue from landing on top of the turn cue.
        this.nextGuidance = Math.max(this.nextGuidance, t + cue.duration + (this.ambient ? 0.3 : 0.08));
      }
      this.nextManeuver = Math.max(now, this.nextManeuver) + (cue?.interval ?? 0.2);
    }
  }

  /** Keep the background bed in step with the settings and the navigation state. */
  private updateSoundscape(st: NavState | null, now: number): void {
    const s = this.settings;
    const want = this.ambient && s.soundscape > 0;
    const root = s.basePitch / 4;
    // Rebuild if it's no longer wanted or its key / panning changed.
    if (this.scape && (!want || this.scapeKey !== `${root}|${s.panMode}`)) {
      this.scape.stop();
      this.scape = null;
    }
    if (!want) return;
    if (!this.scape) {
      this.scape = new Soundscape(this.ctx!, this.bus!, root, s.panMode);
      this.scapeKey = `${root}|${s.panMode}`;
    }
    // Parameters glide anyway; ~10 updates/s is plenty and keeps automation lists short.
    if (now - this.lastScapeUpdate < 0.1) return;
    this.lastScapeUpdate = now;
    this.scape.update(soundscapeFor(st, s), s.soundscape);
  }

  /** A spatializer placed at the cue's direction, feeding the bus. */
  private placed(azimuth: number, pan: number): AudioNode {
    const node = spatializer(this.ctx!, this.settings.panMode, azimuth, pan);
    node.connect(this.bus!);
    return node;
  }

  private play(cue: Cue, t: number): void {
    const ctx = this.ctx!;
    const dest = this.placed(cue.azimuth, cue.pan);
    if (this.ambient) {
      if (cue.kind !== 'tick') this.scape?.duck(t);
      const g = cue.gain;
      switch (cue.kind) {
        case 'beep':
          chime(ctx, dest, t, { freq: cue.freq, gain: g * 0.8, decay: 1.2, bright: 0.4, uneasy: cue.timbre === 'square' });
          break;
        case 'tick':
          // A faint droplet an octave up: "all good", barely there.
          chime(ctx, dest, t, { freq: cue.freq * 2, gain: g * 0.35, decay: 0.45, bright: 0 });
          break;
        case 'behind':
          // A low, warm gong on the side to turn towards.
          chime(ctx, dest, t, { freq: cue.freq, gain: g * 1.4, decay: 1.8, bright: 0.9 });
          break;
        case 'chirp':
          chime(ctx, dest, t, { freq: cue.freq, gain: g * 0.6, decay: 0.9, bright: 0.5 });
          chime(ctx, dest, t + 0.15, { freq: cue.freq2 ?? cue.freq, gain: g * 0.6, decay: 1.1, bright: 0.5 });
          break;
      }
      return;
    }
    const spec = { freq: cue.freq, freq2: cue.freq2, type: cue.timbre, duration: cue.duration, gain: cue.gain };
    if (cue.kind === 'chirp') chirp(ctx, dest, t, spec);
    else tone(ctx, dest, t, spec);
  }

  private updateVoice(p: ToneParams | null): void {
    const ctx = this.ctx!;
    const mode = this.settings.panMode;
    if (this.voice && this.voice.mode !== mode) this.stopVoice();
    if (!this.voice) {
      const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 440 });
      const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.3 });
      const gain = new GainNode(ctx, { gain: 0 });
      const pan = spatializer(ctx, mode, 0, 0) as StereoPannerNode | PannerNode;
      osc.connect(filter).connect(gain).connect(pan).connect(this.bus!);
      osc.start();
      this.voice = { osc, filter, gain, pan, mode };
    }
    const v = this.voice;
    const t = ctx.currentTime;
    // Ambient glides slowly between states; classic follows quickly.
    const tc = this.ambient ? 0.25 : 0.05;
    if (!p) {
      v.gain.gain.setTargetAtTime(0, t, tc);
      return;
    }
    // Ambient: harsh waveforms become a soft, filtered triangle.
    const type = this.ambient && p.timbre !== 'sine' ? 'triangle' : p.timbre;
    if (v.osc.type !== type) v.osc.type = type;
    v.filter.frequency.setTargetAtTime(this.ambient ? p.freq * 2.5 : 20000, t, tc);
    const level = type === 'sine' || type === 'triangle' ? p.gain : p.gain * 0.45;
    v.gain.gain.setTargetAtTime(level, t, tc);
    v.osc.frequency.setTargetAtTime(p.freq, t, tc);
    if (v.pan instanceof StereoPannerNode) {
      v.pan.pan.setTargetAtTime(p.pan, t, tc);
    } else {
      const rad = (p.azimuth * Math.PI) / 180;
      v.pan.positionX.setTargetAtTime(Math.sin(rad), t, tc);
      v.pan.positionZ.setTargetAtTime(-Math.cos(rad), t, tc);
    }
  }

  private stopVoice(): void {
    if (!this.voice || !this.ctx) return;
    const v = this.voice;
    v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    v.osc.stop(this.ctx.currentTime + 0.2);
    this.voice = null;
  }

  /** One-off sounds for navigation events. */
  event(e: AudioEvent): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const t = ctx.currentTime + 0.02;
    const center = this.placed(0, 0);
    const b = this.settings.basePitch / 2;
    if (this.ambient) {
      if (e !== 'maneuverPassed') this.scape?.duck(t);
      // Pentatonic intervals only (ratios of the major pentatonic), so events blend in.
      const seq = (ratios: number[], step: number, gain: number, decay: number, uneasy = false) =>
        ratios.forEach((r, i) => chime(ctx, center, t + i * step, { freq: b * r, gain, decay, bright: 0.5, uneasy }));
      switch (e) {
        case 'offRoute':
          // Two falling, slightly clouded notes: "hm, not this way".
          seq([1.5, 1.189], 0.22, 0.45, 1.4, true);
          this.busyUntil = t + 0.8;
          break;
        case 'backOnRoute':
          seq([1, 1.5], 0.18, 0.35, 1.2);
          break;
        case 'rerouted':
          seq([1, 1.25, 1.5], 0.07, 0.3, 1.6);
          this.busyUntil = t + 0.8;
          break;
        case 'arrived':
          seq([1, 1.125, 1.25, 1.5, 1.667, 2], 0.16, 0.35, 2);
          this.busyUntil = t + 1.6;
          break;
        case 'maneuverPassed':
          chime(ctx, center, t, { freq: b * 3, gain: 0.08, decay: 0.4, bright: 0 });
          break;
      }
      return;
    }
    switch (e) {
      case 'offRoute':
        noiseBurst(ctx, center, t, 0.35, 0.6);
        this.busyUntil = t + 0.45;
        break;
      case 'backOnRoute':
        notes(ctx, center, t, [b, b * 1.5], 0.09, 0.12, 0.35);
        break;
      case 'rerouted':
        // A major chord: "new route found".
        notes(ctx, center, t, [b, b * 1.26, b * 1.5], 0, 0.35, 0.22);
        this.busyUntil = t + 0.4;
        break;
      case 'arrived':
        notes(ctx, center, t, [b, b * 1.26, b * 1.5, b * 2], 0.14, 0.25, 0.35);
        this.busyUntil = t + 0.9;
        break;
      case 'maneuverPassed':
        tone(ctx, center, t, { freq: b * 2, type: 'sine', duration: 0.03, gain: 0.15 });
        break;
    }
  }

  /** Orientation check: left, half-left, ahead, half-right, right, behind. */
  testSweep(): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const gap = this.ambient ? 0.7 : 0.45;
    const t0 = ctx.currentTime + 0.05;
    const base = this.settings.basePitch;
    [-90, -45, 0, 45, 90, 180].forEach((az, i) => {
      const behind = Math.abs(az) > 90;
      const dest = this.placed(az, behind ? 0 : panFor(az));
      const t = t0 + i * gap;
      if (this.ambient) {
        chime(ctx, dest, t, behind ? { freq: base / 4, gain: 0.5, decay: 1.8, bright: 0.9 } : { freq: base, gain: 0.4, decay: 1.2, bright: 0.4 });
      } else {
        tone(ctx, dest, t, { freq: behind ? base / 4 : base, type: behind ? 'sawtooth' : 'sine', duration: 0.15, gain: 0.5 });
      }
    });
    this.busyUntil = t0 + 6 * gap;
  }
}
