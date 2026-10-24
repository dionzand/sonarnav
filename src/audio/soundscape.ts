import { SoundscapeParams } from './mapping';
import { PanMode, Spatial, createSpatial } from './synth';

// Pad chord as ratios of the root (two octaves below the base note).
// Resolved: root, fifth, octave, major tenth. Suspended: the tenth rises to an eleventh (sus4).
const RESOLVED = [1, 1.5, 2, 2.5];
const SUSPENDED = [1, 1.5, 2, 2.667];
const VOICE_GAIN = [0.5, 0.32, 0.22, 0.14];
const DETUNE_CENTS = 5;

/**
 * Continuous ambient bed under the chimes: a slowly breathing pad that resolves or
 * suspends with your route status, plus a soft "breeze" that comes from where to go.
 */
export class Soundscape {
  private out: GainNode;
  private duckGain: GainNode;
  private filter: BiquadFilterNode;
  private lfo: OscillatorNode;
  private voices: OscillatorNode[][] = [];
  private breezeGain: GainNode;
  private breezePan: Spatial;
  private nodes: AudioScheduledSourceNode[] = [];

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private root: number,
    panMode: PanMode,
  ) {
    const t = ctx.currentTime;
    this.out = new GainNode(ctx, { gain: 0 });
    this.duckGain = new GainNode(ctx, { gain: 1 });
    this.out.connect(this.duckGain).connect(dest);

    // Pad: pairs of slightly detuned triangles per chord note → shared low-pass.
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 700, Q: 0.5 });
    const padGain = new GainNode(ctx, { gain: 0.16 });
    this.filter.connect(padGain).connect(this.out);
    RESOLVED.forEach((ratio, i) => {
      const pair = [-DETUNE_CENTS, DETUNE_CENTS].map((detune) => {
        const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: root * ratio, detune });
        const g = new GainNode(ctx, { gain: VOICE_GAIN[i] / 2 });
        osc.connect(g).connect(this.filter);
        osc.start(t);
        this.nodes.push(osc);
        return osc;
      });
      this.voices.push(pair);
    });

    // Breathing: a very slow LFO on the cutoff and the level.
    this.lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.05 });
    const lfoToCutoff = new GainNode(ctx, { gain: 180 });
    const lfoToLevel = new GainNode(ctx, { gain: 0.04 });
    this.lfo.connect(lfoToCutoff).connect(this.filter.frequency);
    this.lfo.connect(lfoToLevel).connect(padGain.gain);
    this.lfo.start(t);
    this.nodes.push(this.lfo);

    // Breeze: looping band-passed noise, spatialized toward the beacon.
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise: softer and more "airy" than white noise.
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const noise = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 700, Q: 0.6 });
    this.breezeGain = new GainNode(ctx, { gain: 0 });
    this.breezePan = createSpatial(ctx, panMode, 0, 0);
    noise.connect(band).connect(this.breezeGain).connect(this.breezePan.input);
    this.breezePan.output.connect(this.out);
    // Slow gusts on the breeze filter.
    const gust = new OscillatorNode(ctx, { type: 'sine', frequency: 0.13 });
    const gustDepth = new GainNode(ctx, { gain: 250 });
    gust.connect(gustDepth).connect(band.frequency);
    noise.start(t);
    gust.start(t);
    this.nodes.push(noise, gust);
  }

  /** Glide toward new parameters. `level` is the user's soundscape volume times p.level. */
  update(p: SoundscapeParams, level: number): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(level * p.level, t, 0.8);
    this.filter.frequency.setTargetAtTime(p.cutoff, t, 0.6);
    this.lfo.frequency.setTargetAtTime(p.breath, t, 2);
    // The chord moves slowly, like a pad changing harmony.
    const chord = p.tension > 0.5 ? SUSPENDED : RESOLVED;
    this.voices.forEach((pair, i) => pair.forEach((osc) => osc.frequency.setTargetAtTime(this.root * chord[i], t, 0.7)));
    this.breezeGain.gain.setTargetAtTime(p.breezeLevel * 0.5, t, 0.35);
    this.breezePan.set(p.breezeAzimuth, p.breezePan, t, 0.3);
  }

  /** Dip briefly under a chime so it sits inside the bed rather than on top. */
  duck(at: number): void {
    const g = this.duckGain.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(0.6, at, 0.04);
    g.setTargetAtTime(1, at + 0.25, 0.5);
  }

  /** Fade out and release everything. */
  stop(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.3);
    for (const n of this.nodes) n.stop(t + 2);
  }
}
