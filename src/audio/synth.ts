// Sound primitives. Everything is synthesized; no sample files.

export type PanMode = 'hrtf' | 'stereo';

/** A node that places a sound at an azimuth (HRTF) or a stereo pan position. */
export function spatializer(ctx: AudioContext, mode: PanMode, azimuth: number, pan: number): AudioNode {
  if (mode === 'stereo') {
    return new StereoPannerNode(ctx, { pan });
  }
  const rad = (azimuth * Math.PI) / 180;
  return new PannerNode(ctx, {
    panningModel: 'HRTF',
    distanceModel: 'linear',
    rolloffFactor: 0,
    // Listener faces -z; +x is right.
    positionX: Math.sin(rad),
    positionY: 0,
    positionZ: -Math.cos(rad),
  });
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
