import { NavState } from '../core/navigator';
import { Profile } from '../core/route';
import { AudioSettings, Cue, panFor } from './mapping';
import { CueScheme, ToneParams } from './schemes';
import { chirp, noiseBurst, notes, spatializer, tone } from './synth';

export type AudioEvent = 'offRoute' | 'backOnRoute' | 'arrived' | 'rerouted' | 'maneuverPassed';

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode | PannerNode;
  mode: AudioSettings['panMode'];
}

/**
 * Drives the cue scheme from the latest NavState. A 25 ms timer schedules each stream's
 * next cue slightly ahead on the audio clock, so timing stays tight even if frames drop.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private state: NavState | null = null;
  private nextGuidance = 0;
  private nextManeuver = 0;
  private voice: Voice | null = null;
  private busyUntil = 0; // suppress guidance while an event sound plays

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

  /** Must be called from a user gesture (browser autoplay rules). */
  async start(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = new GainNode(this.ctx, { gain: this.settings.volume });
      const comp = new DynamicsCompressorNode(this.ctx, { threshold: -12, ratio: 4 });
      this.master.connect(comp).connect(this.ctx.destination);
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
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const ahead = 0.05;
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
    } else if (this.scheme.guidance && now + ahead >= this.nextGuidance) {
      const cue = now < this.busyUntil ? null : this.scheme.guidance(st, s, profile);
      this.lastGuidance = cue;
      if (cue && cue.gain > 0) this.play(cue, Math.max(now + 0.01, this.nextGuidance));
      this.nextGuidance = Math.max(now, this.nextGuidance) + (cue?.interval ?? 0.2);
    }

    if (now + ahead >= this.nextManeuver) {
      const cue = this.scheme.maneuver(st, s, profile);
      this.lastManeuver = cue;
      if (cue) {
        const t = Math.max(now + 0.01, this.nextManeuver);
        this.play(cue, t);
        // Keep the guidance beep from landing on top of the chirp.
        this.nextGuidance = Math.max(this.nextGuidance, t + cue.duration + 0.08);
      }
      this.nextManeuver = Math.max(now, this.nextManeuver) + (cue?.interval ?? 0.2);
    }
  }

  private play(cue: Cue, t: number): void {
    const ctx = this.ctx!;
    const dest = spatializer(ctx, this.settings.panMode, cue.azimuth, cue.pan);
    dest.connect(this.master!);
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
      const gain = new GainNode(ctx, { gain: 0 });
      const pan = spatializer(ctx, mode, 0, 0) as StereoPannerNode | PannerNode;
      osc.connect(gain).connect(pan).connect(this.master!);
      osc.start();
      this.voice = { osc, gain, pan, mode };
    }
    const v = this.voice;
    const t = ctx.currentTime;
    const tc = 0.05;
    if (!p) {
      v.gain.gain.setTargetAtTime(0, t, tc);
      return;
    }
    if (v.osc.type !== p.timbre) v.osc.type = p.timbre;
    const level = p.timbre === 'sine' ? p.gain : p.gain * 0.45;
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
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + 0.02;
    const center = spatializer(ctx, this.settings.panMode, 0, 0);
    center.connect(this.master);
    const b = this.settings.basePitch / 2;
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
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + 0.05;
    [-90, -45, 0, 45, 90, 180].forEach((az, i) => {
      const behind = Math.abs(az) > 90;
      const dest = spatializer(ctx, this.settings.panMode, az, behind ? 0 : panFor(az));
      dest.connect(this.master!);
      tone(ctx, dest, t0 + i * 0.45, {
        freq: behind ? this.settings.basePitch / 4 : this.settings.basePitch,
        type: behind ? 'sawtooth' : 'sine',
        duration: 0.15,
        gain: 0.5,
      });
    });
    this.busyUntil = t0 + 6 * 0.45;
  }
}
