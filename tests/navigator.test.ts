import { describe, expect, it } from 'vitest';
import { LngLat, destination } from '../src/core/geo';
import { DEFAULT_NAV, Navigator } from '../src/core/navigator';
import { makeRoute } from './helpers';

const START: LngLat = [4.9, 52.37];
const CORNER = destination(START, 90, 200);
const route = () =>
  makeRoute(START, [
    [90, 200],
    [180, 200],
  ]);

describe('navigator', () => {
  it('points the beacon straight ahead when on course', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 50), 90, 5, 0);
    expect(Math.abs(st.relBearing)).toBeLessThan(1);
    expect(st.along).toBeCloseTo(50, 0);
    expect(st.next?.angle).toBeCloseTo(90, 0);
    expect(st.distanceToNext).toBeCloseTo(150, 0);
  });

  it('beacon is to the right when you face left of the route', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 50), 45, 5, 0);
    expect(st.relBearing).toBeCloseTo(45, 0);
  });

  it('beacon is behind when you face the wrong way', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    const st = nav.update(destination(START, 90, 50), 270, 5, 0);
    expect(Math.abs(st.relBearing)).toBeGreaterThan(170);
  });

  it('beacon waits on the corner, then swings around it', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    // 30 m before the corner: beacon is held on the corner, dead ahead.
    let st = nav.update(destination(START, 90, 170), 90, 5, 0);
    expect(Math.abs(st.relBearing)).toBeLessThan(1);
    // 5 m before (inside cornerCommit): beacon jumps past the corner, well to the right.
    st = nav.update(destination(START, 90, 195), 90, 5, 1);
    expect(st.relBearing).toBeGreaterThan(60);
  });

  it('passes maneuvers and raises an event', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    nav.update(destination(START, 90, 150), 90, 5, 0);
    const st = nav.update(destination(CORNER, 180, 20), 180, 5, 1);
    expect(st.events).toContain('maneuverPassed');
    expect(st.next).toBeNull();
  });

  it('goes off-route only after the delay, and back with hysteresis', () => {
    const s = DEFAULT_NAV.bike;
    const nav = new Navigator(route(), s);
    const far = destination(destination(START, 90, 100), 0, s.offRouteDistance + 10);
    expect(nav.update(far, 90, 5, 0).offRoute).toBe(false);
    expect(nav.update(far, 90, 5, s.offRouteDelay - 0.1).offRoute).toBe(false);
    const st = nav.update(far, 90, 5, s.offRouteDelay + 0.1);
    expect(st.offRoute).toBe(true);
    expect(st.events).toContain('offRoute');
    // Back inside the threshold but above 60 % of it: still off.
    const mid = destination(destination(START, 90, 100), 0, s.offRouteDistance * 0.8);
    expect(nav.update(mid, 90, 5, 10).offRoute).toBe(true);
    const back = nav.update(destination(START, 90, 100), 90, 5, 11);
    expect(back.offRoute).toBe(false);
    expect(back.events).toContain('backOnRoute');
  });

  it('arrives at the end', () => {
    const nav = new Navigator(route(), DEFAULT_NAV.bike);
    nav.update(destination(START, 90, 199), 90, 5, 0);
    nav.update(destination(CORNER, 180, 100), 180, 5, 1);
    const st = nav.update(destination(CORNER, 180, 195), 180, 5, 2);
    expect(st.arrived).toBe(true);
    expect(st.events).toContain('arrived');
  });
});
