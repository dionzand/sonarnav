// Sound primitives. Everything is synthesized; no sample files.

import type { PanMode } from './mapping';
export type { PanMode };

/**
 * Places sound in space. Connect sources to `input`, and `output` to the mix.
 * `set` moves it (instantly, or gliding with time constant `tc`).
 */
export interface Spatial {
  input: AudioNode;
  output: AudioNode;
  set(azimuth: number, pan: number, at: number, tc?: number): void;
}

function apply(p: AudioParam, v: number, at: number, tc: number): void {
  if (tc > 0) p.setTargetAtTime(v, at, tc);
  else p.setValueAtTime(v, at);
}

// Binaural cues of a real head at 90°: ~0.68 ms interaural delay, far ear ~14 dB quieter
// and muffled (the head shadows high frequencies).
const MAX_ITD = 0.00068;
const FAR_EAR_GAIN = 0.2;
const FAR_EAR_CUTOFF = 1100;

/**
 * Binaural: per-ear delay, level and head-shadow filter. Lateralizes much more strongly than
 * plain panning (the brain uses timing differences most), without HRTF's front/back blur.
 */
function binaural(ctx: AudioContext, pan: number): Spatial {
  const input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  const ears = [0, 1].map((ch) => {
    const delay = new DelayNode(ctx, { maxDelayTime: 0.002 });
    const shadow = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 18000, Q: 0.5 });
    const level = new GainNode(ctx);
    input.connect(delay).connect(shadow).connect(level).connect(merger, 0, ch);
    return { delay, shadow, level };
  });
  const set = (_az: number, p: number, at: number, tc = 0) => {
    // x: -1 full left … +1 full right (sine law, like a source moving round the head).
    const x = Math.sin((Math.max(-1, Math.min(1, p)) * Math.PI) / 2);
    ears.forEach((ear, ch) => {
      const far = Math.max(0, ch === 0 ? x : -x); // left ear is far when the sound is right
      apply(ear.delay.delayTime, MAX_ITD * far, at, tc);
      apply(ear.shadow.frequency, 18000 * Math.pow(FAR_EAR_CUTOFF / 18000, far), at, tc);
      apply(ear.level.gain, 1 - (1 - FAR_EAR_GAIN) * far, at, tc);
    });
  };
  set(0, pan, ctx.currentTime);
  return { input, output: merger, set };
}

export function createSpatial(ctx: AudioContext, mode: PanMode, azimuth: number, pan: number): Spatial {
  if (mode === 'binaural') return binaural(ctx, pan);
  if (mode === 'stereo') {
    const node = new StereoPannerNode(ctx, { pan });
    return { input: node, output: node, set: (_az, p, at, tc = 0) => apply(node.pan, p, at, tc) };
  }
  const node = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0 });
  const set = (az: number, _p: number, at: number, tc = 0) => {
    const rad = (az * Math.PI) / 180;
    // Listener faces -z; +x is right.
    apply(node.positionX, Math.sin(rad), at, tc);
    apply(node.positionY, 0, at, tc);
    apply(node.positionZ, -Math.cos(rad), at, tc);
  };
  set(azimuth, pan, ctx.currentTime);
  return { input: node, output: node, set };
}

/** Attack/decay envelope that avoids clicks. */
function envelope(ctx: AudioContext, t: number, duration: number, gain: number): GainNode {
  const g = new GainNode(ctx, { gain: 0 });
  const attack = Math.min(0.008, duration / 4);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setTargetAtTime(0, t + Math.max(attack, duration - 0.02), 0.012);
  return g;
}

export interface ToneSpec {
  freq: number;
  freq2?: number;
  type: OscillatorType;
  duration: number;
  gain: number;
}

/** A single tone, optionally gliding to freq2, routed into `dest` (usually a spatializer). */
export function tone(ctx: AudioContext, dest: AudioNode, t: number, spec: ToneSpec): void {
  const osc = new OscillatorNode(ctx, { type: spec.type, frequency: spec.freq });
  if (spec.freq2) {
    osc.frequency.setValueAtTime(spec.freq, t);
    osc.frequency.exponentialRampToValueAtTime(spec.freq2, t + spec.duration);
  }
  // Square/saw are much louder than sine at the same amplitude.
  const level = spec.type === 'sine' || spec.type === 'triangle' ? spec.gain : spec.gain * 0.45;
  const env = envelope(ctx, t, spec.duration, level);
  osc.connect(env).connect(dest);
  osc.start(t);
  osc.stop(t + spec.duration + 0.15);
}

/** Two-step chirp: freq then freq2, with a short gap. Reads as a "turn" signal. */
export function chirp(ctx: AudioContext, dest: AudioNode, t: number, spec: ToneSpec): void {
  const half = spec.duration / 2;
  tone(ctx, dest, t, { ...spec, freq2: undefined, duration: half });
  tone(ctx, dest, t + half + 0.025, { ...spec, freq: spec.freq2 ?? spec.freq, freq2: undefined, duration: half });
}

/** Band-passed noise burst: the "off route" alarm. */
export function noiseBurst(ctx: AudioContext, dest: AudioNode, t: number, duration: number, gain: number): void {
  const len = Math.ceil(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1200, Q: 1.2 });
  src.connect(bp).connect(envelope(ctx, t, duration, gain)).connect(dest);
  src.start(t);
}

export interface ChimeSpec {
  freq: number;
  gain: number;
  /** Seconds until the chime has mostly faded. */
  decay: number;
  /** 0 = pure and round, 1 = a little more shimmer. */
  bright?: number;
  /** Add a quietly beating neighbour partial: gently "uneasy" (used when off route). */
  uneasy?: boolean;
}

// Near-harmonic partials (a soft bell / kalimba). Higher partials are quieter and die faster.
const PARTIALS = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.0, gain: 0.28, decay: 0.55 },
  { ratio: 3.01, gain: 0.09, decay: 0.35 },
  { ratio: 4.2, gain: 0.035, decay: 0.2 },
];

/** Soft, round chime: gentle attack, long exponential tail, low-passed. */
export function chime(ctx: AudioContext, dest: AudioNode, t: number, spec: ChimeSpec): void {
  const bright = spec.bright ?? 0.5;
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: Math.min(6000, spec.freq * (3 + 4 * bright)), Q: 0.3 });
  lp.connect(dest);
  const partials = spec.uneasy ? [...PARTIALS, { ratio: 1.059, gain: 0.45, decay: 0.8 }] : PARTIALS;
  for (const p of partials) {
    const level = spec.gain * p.gain * (p.ratio > 1.5 ? 0.4 + bright : 1);
    if (level < 0.002) continue;
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: spec.freq * p.ratio });
    const g = new GainNode(ctx, { gain: 0 });
    const decay = spec.decay * p.decay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.012);
    g.gain.setTargetAtTime(0, t + 0.012, decay / 4);
    osc.connect(g).connect(lp);
    osc.start(t);
    osc.stop(t + decay * 1.5 + 0.1);
  }
}

/** A synthetic room: stereo noise with an exponential tail, for a soft ambient wash. */
export function reverbImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.ceil(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

/** Notes played in sequence (motifs) or together (chords) when `step` is 0. */
export function notes(
  ctx: AudioContext,
  dest: AudioNode,
  t: number,
  freqs: number[],
  step: number,
  duration: number,
  gain: number,
): void {
  freqs.forEach((f, i) => tone(ctx, dest, t + i * step, { freq: f, type: 'triangle', duration, gain }));
}
