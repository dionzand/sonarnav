import { describe, expect, it } from 'vitest';
import { LngLat, destination, distance } from '../src/core/geo';
import { Simulator } from '../src/position/simulator';
import { StreetNetwork } from '../src/position/streets';

const A: LngLat = [4.9, 52.37];

function drive(sim: Simulator, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) sim.tick(1 / 60);
}

describe('simulator', () => {
  it('moves along the heading at cruise speed', () => {
    const sim = new Simulator(A);
    sim.profile = 'foot';
    sim.setHeading(90);
    sim.speed = 1.5;
    drive(sim, 10);
    expect(distance(A, sim.position)).toBeCloseTo(15, 0);
  });

  it('snaps to streets but does not get stuck at the end of a way', () => {
    const end = destination(A, 0, 30);
    const sim = new Simulator(A);
    sim.streets = new StreetNetwork([[A, end]]);
    sim.snapMode = 'streets';
    sim.setHeading(10); // slightly off the street direction
    sim.speed = 5;
    drive(sim, 4); // 20 m: still on the street
    expect(sim.streets.nearest(sim.position)!.distance).toBeLessThan(0.1);
    drive(sim, 4); // past the dead end: carries on
    expect(distance(A, sim.position)).toBeGreaterThan(35);
  });

  it('turns by exact steps and wraps', () => {
    const sim = new Simulator(A);
    sim.turnBy(-15);
    expect(sim.heading).toBe(345);
    sim.turnBy(180);
    expect(sim.heading).toBe(165);
  });
});
