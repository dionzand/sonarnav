import { describe, expect, it } from 'vitest';
import { LngLat, destination } from '../src/core/geo';
import { DEFAULT_NAV, Navigator } from '../src/core/navigator';
import {
  DEFAULT_AUDIO,
  IDLE_SOUNDSCAPE,
  beaconBeep,
  emphasize,
  panFor,
  pitchFor,
  soundscapeFor,
  turnInterval,
  turnPreview,
} from '../src/audio/mapping';
import { SCHEMES } from '../src/audio/schemes';
import { makeRoute } from './helpers';

const START: LngLat = [4.9, 52.37];
const r = () =>
  makeRoute(START, [
    [90, 200],
    [130, 200],
  ]);
/** Settings with true (unexaggerated) angles, for exact pan checks. */
const TRUE_ANGLES = { ...DEFAULT_AUDIO, directionEmphasis: 1 };

describe('cue mapping', () => {
  it('pans linearly with angle and clamps', () => {
    expect(panFor(0)).toBe(0);
    expect(panFor(45)).toBeCloseTo(0.5);
    expect(panFor(-90)).toBe(-1);
    expect(panFor(150)).toBe(1);
  });

  it('emphasis exaggerates frontal angles, clamps at 90°, leaves "behind" alone', () => {
    expect(emphasize(20, 1.6)).toBeCloseTo(32);
    expect(emphasize(-80, 1.6)).toBe(-90);
    expect(emphasize(150, 1.6)).toBe(150);
    expect(emphasize(30, 1)).toBe(30);
  });

  it('pitch works like a piano: right goes up, left goes down, an octave at 90°', () => {
    expect(pitchFor(0, 440)).toBe(440);
    expect(pitchFor(90, 440)).toBeCloseTo(880);
    expect(pitchFor(-90, 440)).toBeCloseTo(220);
    expect(pitchFor(45, 440)).toBeGreaterThan(440);
    expect(pitchFor(-45, 440)).toBeLessThan(440);
  });

  it('ambient pitch steps through pentatonic notes on both sides', () => {
    expect(pitchFor(0, 440, true)).toBe(440);
    expect(pitchFor(45, 440, true)).toBeCloseTo(440 * 2 ** (7 / 12)); // 6 semitones up → a fifth
    expect(pitchFor(-45, 440, true)).toBeCloseTo(440 * 2 ** (-5 / 12)); // 6 down → a fourth
    expect(pitchFor(90, 440, true)).toBeCloseTo(880);
    // Small angle changes inside one step keep the same note.
    expect(pitchFor(16, 440, true)).toBe(pitchFor(20, 440, true));
  });

  it('beacon 45° right: pan +0.5 (true angles) or further out with emphasis; tick on course; behind buzz', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const p = destination(START, 90, 50);
    const st = nav.update(p, 45, 5, 0);
    let cue = beaconBeep(st, TRUE_ANGLES)!;
    expect(cue.kind).toBe('beep');
    expect(cue.pan).toBeCloseTo(0.5, 1);
    expect(cue.freq).toBeGreaterThan(DEFAULT_AUDIO.basePitch); // right → higher
    expect(beaconBeep(st, DEFAULT_AUDIO)!.pan).toBeCloseTo(0.8, 1);
    cue = beaconBeep(nav.update(p, 135, 5, 0), DEFAULT_AUDIO)!; // beacon 45° to the left
    expect(cue.freq).toBeLessThan(DEFAULT_AUDIO.basePitch);
    cue = beaconBeep(nav.update(p, 90, 5, 0), DEFAULT_AUDIO)!;
    expect(cue.kind).toBe('tick');
    // Facing roughly west-south-west, the beacon (east) is behind you, over your left shoulder.
    cue = beaconBeep(nav.update(p, 250, 5, 0), DEFAULT_AUDIO)!;
    expect(cue.kind).toBe('behind');
    expect(cue.pan).toBe(-1);
  });

  it('turn interval accelerates geometrically towards the corner', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((c) => turnInterval(c, 'ambient'));
    expect(steps[0]).toBeCloseTo(2.6);
    expect(steps[4]).toBeCloseTo(0.3);
    // Each quarter shortens the interval by the same factor: a steady build-up.
    for (let i = 1; i < steps.length; i++) expect(steps[i] / steps[i - 1]).toBeCloseTo(steps[1] / steps[0]);
  });

  it('turn preview builds up: faster, higher, louder; panned at the real angle', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    expect(turnPreview(nav.update(destination(START, 90, 100), 90, 5, 0), DEFAULT_AUDIO, 'bike')).toBeNull();
    const far = turnPreview(nav.update(destination(START, 90, 145), 90, 5, 1), TRUE_ANGLES, 'bike')!;
    const near = turnPreview(nav.update(destination(START, 90, 195), 90, 5, 2), TRUE_ANGLES, 'bike')!;
    expect(far.azimuth).toBeCloseTo(40, 0);
    expect(far.pan).toBeCloseTo(40 / 90, 1);
    expect(near.interval).toBeLessThan(far.interval / 4);
    expect(near.gain).toBeGreaterThan(far.gain * 2);
    expect(near.freq).toBeGreaterThan(far.freq);
    // A right turn steps up.
    expect(far.freq2!).toBeGreaterThan(far.freq);
  });

  it('a left turn steps down', () => {
    const left = makeRoute(START, [
      [90, 200],
      [10, 200],
    ]);
    const nav = new Navigator(left, DEFAULT_NAV.bike);
    const cue = turnPreview(nav.update(destination(START, 90, 170), 90, 5, 0), DEFAULT_AUDIO, 'bike')!;
    expect(cue.pan).toBeLessThan(0);
    expect(cue.freq2!).toBeLessThan(cue.freq);
  });

  it('ambient turn cue starts below the base note; classic stays high', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 145), 90, 5, 0);
    const ambient = turnPreview(st, DEFAULT_AUDIO, 'bike')!.freq;
    expect(ambient).toBeGreaterThanOrEqual(DEFAULT_AUDIO.basePitch * 0.75 - 0.01);
    expect(ambient).toBeLessThan(DEFAULT_AUDIO.basePitch);
    expect(turnPreview(st, { ...DEFAULT_AUDIO, style: 'classic' }, 'bike')!.freq).toBeGreaterThanOrEqual(DEFAULT_AUDIO.basePitch * 1.5 - 0.01);
  });

  it('soundscape: calm and resolved on course, breeze swells and darkens when turned away', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const p = destination(START, 90, 50);
    const on = soundscapeFor(nav.update(p, 90, 5, 0), TRUE_ANGLES);
    const off = soundscapeFor(nav.update(p, 30, 5, 0), TRUE_ANGLES);
    expect(on.tension).toBe(0);
    expect(off.breezeLevel).toBeGreaterThan(on.breezeLevel * 2);
    expect(off.breezePan).toBeCloseTo(60 / 90, 1); // beacon is 60° to the right
    expect(off.cutoff).toBeLessThan(on.cutoff);
    expect(soundscapeFor(null, DEFAULT_AUDIO)).toBe(IDLE_SOUNDSCAPE);
    expect(soundscapeFor(nav.update(p, 30, 5, 0), { ...DEFAULT_AUDIO, breeze: false }).breezeLevel).toBe(0);
  });

  it('soundscape suspends its chord when off route', () => {
    const s = DEFAULT_NAV.bike;
    const nav = new Navigator(r(), s);
    const far = destination(destination(START, 90, 100), 0, s.offRouteDistance + 10);
    nav.update(far, 90, 5, 0);
    expect(soundscapeFor(nav.update(far, 90, 5, s.offRouteDelay + 1), DEFAULT_AUDIO).tension).toBe(1);
  });

  it('events-only scheme stays quiet when roughly on course', () => {
    const events = SCHEMES.find((s) => s.id === 'events')!;
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 50), 75, 5, 0);
    expect(events.guidance!(st, DEFAULT_AUDIO, 'bike')).toBeNull();
    expect(SCHEMES[0].guidance!(st, DEFAULT_AUDIO, 'bike')?.kind).toBe('beep');
  });
});
