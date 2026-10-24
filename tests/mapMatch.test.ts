import { describe, expect, it } from 'vitest';
import { LngLat, destination, distance } from '../src/core/geo';
import { MapMatcher } from '../src/position/mapMatch';
import { StreetNetwork } from '../src/position/streets';

const O: LngLat = [4.9, 52.37];
/** Local metric coordinates: x metres east, y metres north of O. */
const xy = (x: number, y: number): LngLat => destination(destination(O, 90, x), 0, y);

/**
 * Two parallel east–west streets 20 m apart (y = 0 and y = 20), joined by a
 * north–south street at x = 200. Both long streets have a node at x = 200.
 */
function grid(): StreetNetwork {
  return new StreetNetwork([
    [xy(0, 0), xy(200, 0), xy(400, 0)],
    [xy(0, 20), xy(200, 20), xy(400, 20)],
    [xy(200, 0), xy(200, 20), xy(200, 60)],
  ]);
}

const fix = (p: LngLat, heading: number, t: number, accuracy = 10) => ({ position: p, heading, speed: 1.4, time: t, accuracy });

describe('map-matching', () => {
  it('keeps you on your street when GPS noise drifts towards the parallel one', () => {
    const m = new MapMatcher(grid());
    // Walking east along the south street; GPS wanders north, sometimes closer to the north street.
    const northOffsets = [2, 6, 9, 11, 8, 12, 4, 13, 7];
    northOffsets.forEach((dy, i) => {
      const r = m.match(fix(xy(20 + i * 10, dy), 90, i));
      expect(r.matched).toBe(true);
      expect(distance(r.position, xy(20 + i * 10, 0))).toBeLessThan(1.5);
    });
  });

  it('without history, the nearest street wins', () => {
    const m = new MapMatcher(grid());
    const r = m.match(fix(xy(50, 13), 90, 0));
    expect(distance(r.position, xy(50, 20))).toBeLessThan(1);
  });

  it('follows a real turn onto the connecting street', () => {
    const m = new MapMatcher(grid());
    for (let i = 0; i < 5; i++) m.match(fix(xy(150 + i * 10, 2), 90, i));
    // Now walking north up the x = 200 street (beyond the north street, so it's unambiguous).
    let r = m.match(fix(xy(203, 10), 0, 6));
    expect(distance(r.position, xy(200, 10))).toBeLessThan(1);
    r = m.match(fix(xy(197, 35), 0, 7));
    expect(distance(r.position, xy(200, 35))).toBeLessThan(1);
  });

  it('steadies the heading to the street direction when moving along it', () => {
    const m = new MapMatcher(grid());
    m.match(fix(xy(50, 2), 85, 0));
    const r = m.match(fix(xy(60, 3), 101, 1));
    expect(r.heading).toBeCloseTo(90, 0);
  });

  it('leaves the fix alone when no street is near', () => {
    const m = new MapMatcher(grid());
    const r = m.match(fix(xy(100, -60), 90, 0, 5));
    expect(r.matched).toBe(false);
    expect(r.position).toEqual(r.raw);
  });

  it('prefers the planned route where streets overlap', () => {
    // Two streets crossing at a shallow angle near the start; the route follows the second.
    const net = new StreetNetwork([
      [xy(0, 0), xy(200, 0)],
      [xy(0, 6), xy(200, 14)],
    ]);
    const route = [xy(0, 6), xy(200, 14)];
    const r = new MapMatcher(net, route).match(fix(xy(100, 5), 90, 0));
    expect(distance(r.position, xy(100, 10))).toBeLessThan(1.5);
  });
});
