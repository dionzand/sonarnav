import { describe, expect, it } from 'vitest';
import { LngLat, destination } from '../src/core/geo';
import { DEFAULT_NAV, Navigator } from '../src/core/navigator';
import { RawIntersection, RawStep, buildRoute } from '../src/core/route';
import { DEFAULT_AUDIO, junctionCue } from '../src/audio/mapping';

const START: LngLat = [4.9, 52.37];
const at = (m: number) => destination(START, 90, m);

/** A straight 500 m route east, with intersections at 150 m (fork) and 300 m (crossing). */
function straightRoute() {
  const geometry: LngLat[] = [];
  for (let m = 0; m <= 500; m += 10) geometry.push(at(m));
  const x = (m: number, bearings: number[]): RawIntersection => ({
    location: at(m),
    bearings,
    entry: bearings.map(() => true),
    in: 1, // arriving from the west (that road points back at 270°)
    out: 0, // leaving east (90°)
  });
  const steps: RawStep[] = [
    { location: START, type: 'depart', name: '', intersections: [{ location: START, bearings: [90], entry: [true], out: 0 }] },
    // At 150 m a branch peels off at 60°: only 30° from the way on. Easy to take by mistake.
    // At 300 m a plain crossing (0° and 180°).
    { location: at(500), type: 'arrive', name: '', intersections: [x(150, [90, 270, 60]), x(300, [90, 270, 0, 180])] },
  ];
  return buildRoute('foot', geometry, steps, 400);
}

describe('junctions', () => {
  it('finds straight-through junctions and flags forks', () => {
    const r = straightRoute();
    expect(r.junctions).toHaveLength(2);
    expect(r.junctions[0].along).toBeCloseTo(150, 0);
    expect(r.junctions[0].fork).toBe(true);
    expect(r.junctions[0].branches[0]).toBeCloseTo(-30, 0);
    expect(r.junctions[1].fork).toBe(false);
  });

  it('ignores intersections where the route turns', () => {
    const geometry: LngLat[] = [];
    for (let m = 0; m <= 200; m += 10) geometry.push(at(m));
    for (let m = 10; m <= 200; m += 10) geometry.push(destination(at(200), 180, m));
    const turn: RawIntersection = { location: at(200), bearings: [180, 270, 90], entry: [true, true, true], in: 1, out: 0 };
    const r = buildRoute('foot', geometry, [{ location: at(200), type: 'turn', name: '', intersections: [turn] }], 300);
    expect(r.junctions).toHaveLength(0);
    expect(r.maneuvers).toHaveLength(1);
  });

  it('navigator tracks the next junction', () => {
    const nav = new Navigator(straightRoute(), DEFAULT_NAV.foot);
    let st = nav.update(at(100), 90, 1.4, 0);
    expect(st.junction?.fork).toBe(true);
    expect(st.distanceToJunction).toBeCloseTo(50, 0);
    st = nav.update(at(200), 90, 1.4, 1);
    expect(st.junction?.fork).toBe(false);
    expect(st.distanceToJunction).toBeCloseTo(100, 0);
  });

  it('"keep straight" cue: level notes, three at a fork; respects the setting', () => {
    const nav = new Navigator(straightRoute(), DEFAULT_NAV.foot);
    const nearFork = nav.update(at(140), 90, 1.4, 0);
    const cue = junctionCue(nearFork, DEFAULT_AUDIO, 'foot')!;
    expect(cue.kind).toBe('straight');
    expect(cue.repeats).toBe(3);
    expect(cue.freq2).toBe(cue.freq);
    expect(cue.pan).toBe(0);
    expect(cue.once).toBe(nearFork.junction); // played once per junction
    expect(junctionCue(nearFork, { ...DEFAULT_AUDIO, junctions: 'off' }, 'foot')).toBeNull();
    // Too far away: nothing yet.
    expect(junctionCue(nav.update(at(100), 90, 1.4, 1), DEFAULT_AUDIO, 'foot')).toBeNull();

    const nearCrossing = nav.update(at(290), 90, 1.4, 2);
    expect(junctionCue(nearCrossing, DEFAULT_AUDIO, 'foot')).toBeNull(); // 'forks' only
    expect(junctionCue(nearCrossing, { ...DEFAULT_AUDIO, junctions: 'all' }, 'foot')!.repeats).toBe(2);
  });
});
