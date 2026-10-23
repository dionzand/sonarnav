import { describe, expect, it } from 'vitest';
import { LngLat, destination } from '../src/core/geo';
import { DEFAULT_NAV, Navigator } from '../src/core/navigator';
import { DEFAULT_AUDIO, beaconBeep, panFor, pitchFor, turnPreview } from '../src/audio/mapping';
import { SCHEMES } from '../src/audio/schemes';
import { makeRoute } from './helpers';

const START: LngLat = [4.9, 52.37];
const r = () =>
  makeRoute(START, [
    [90, 200],
    [130, 200],
  ]);

describe('cue mapping', () => {
  it('pans linearly with angle and clamps', () => {
    expect(panFor(0)).toBe(0);
    expect(panFor(45)).toBeCloseTo(0.5);
    expect(panFor(-90)).toBe(-1);
    expect(panFor(150)).toBe(1);
  });

  it('pitch drops one octave at 90°', () => {
    expect(pitchFor(0, 880)).toBe(880);
    expect(pitchFor(90, 880)).toBeCloseTo(440);
    expect(pitchFor(-45, 880)).toBeCloseTo(880 / Math.SQRT2);
  });

  it('ambient pitch steps through pentatonic notes', () => {
    expect(pitchFor(0, 440, true)).toBe(440);
    expect(pitchFor(45, 440, true)).toBeCloseTo(440 * 2 ** (-5 / 12)); // 6 semitones → nearest is a fourth
    expect(pitchFor(90, 440, true)).toBeCloseTo(220);
    // Small angle changes inside one step keep the same note.
    expect(pitchFor(20, 440, true)).toBe(pitchFor(25, 440, true));
  });

  it('beacon 45° right gives pan +0.5; on course a soft tick; behind a buzz', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const p = destination(START, 90, 50);
    let cue = beaconBeep(nav.update(p, 45, 5, 0), DEFAULT_AUDIO)!;
    expect(cue.kind).toBe('beep');
    expect(cue.pan).toBeCloseTo(0.5, 1);
    cue = beaconBeep(nav.update(p, 90, 5, 0), DEFAULT_AUDIO)!;
    expect(cue.kind).toBe('tick');
    // Facing roughly west-south-west, the beacon (east) is behind you, over your left shoulder.
    cue = beaconBeep(nav.update(p, 250, 5, 0), DEFAULT_AUDIO)!;
    expect(cue.kind).toBe('behind');
    expect(cue.pan).toBe(-1);
  });

  it('turn preview is panned at the real 40° angle and speeds up when closer', () => {
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    expect(turnPreview(nav.update(destination(START, 90, 100), 90, 5, 0), DEFAULT_AUDIO, 'bike')).toBeNull();
    const far = turnPreview(nav.update(destination(START, 90, 160), 90, 5, 1), DEFAULT_AUDIO, 'bike')!;
    const near = turnPreview(nav.update(destination(START, 90, 190), 90, 5, 2), DEFAULT_AUDIO, 'bike')!;
    expect(far.azimuth).toBeCloseTo(40, 0);
    expect(far.pan).toBeCloseTo(40 / 90, 1);
    expect(near.interval).toBeLessThan(far.interval);
  });

  it('events-only scheme stays quiet when roughly on course', () => {
    const events = SCHEMES.find((s) => s.id === 'events')!;
    const nav = new Navigator(r(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 50), 75, 5, 0);
    expect(events.guidance!(st, DEFAULT_AUDIO, 'bike')).toBeNull();
    expect(SCHEMES[0].guidance!(st, DEFAULT_AUDIO, 'bike')?.kind).toBe('beep');
  });
});
