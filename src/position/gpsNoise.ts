import { destination } from '../core/geo';
import { PositionFix, PositionSource } from './provider';

export interface NoiseSettings {
  /** Fix interval (s). Phones typically deliver 1 Hz. */
  interval: number;
  /** Typical horizontal error (m). Urban canyons: 5–15 m. */
  sigma: number;
  /** Heading jitter (°). Compasses wobble a lot when walking. */
  headingSigma: number;
}

export const DEFAULT_NOISE: NoiseSettings = { interval: 1, sigma: 4, headingSigma: 8 };

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Wraps a source and degrades it like a real phone: low update rate, slowly wandering
 * position error (Gauss–Markov, so it drifts instead of jumping), and heading jitter.
 */
export class NoisyGps implements PositionSource {
  enabled = false;
  private ex = 0;
  private ey = 0;
  private last: PositionFix | null = null;

  constructor(
    private source: PositionSource,
    public settings: NoiseSettings = DEFAULT_NOISE,
  ) {}

  current(time: number): PositionFix | null {
    const truth = this.source.current(time);
    if (!truth || !this.enabled) return truth;
    if (this.last && truth.time - this.last.time < this.settings.interval) return this.last;

    const { sigma, headingSigma, interval } = this.settings;
    const corr = Math.exp(-interval / 10); // ~10 s correlation time
    const drive = sigma * Math.sqrt(1 - corr * corr);
    this.ex = corr * this.ex + drive * gauss();
    this.ey = corr * this.ey + drive * gauss();
    const err = Math.hypot(this.ex, this.ey);
    const dir = (Math.atan2(this.ex, this.ey) * 180) / Math.PI;
    this.last = {
      ...truth,
      position: err > 0 ? destination(truth.position, dir, err) : truth.position,
      heading: truth.heading + headingSigma * gauss(),
    };
    return this.last;
  }
}
