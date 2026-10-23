import { describe, expect, it } from 'vitest';
import { describeAngle } from '../src/core/route';
import { makeRoute } from './helpers';

describe('route', () => {
  it('derives exact turn angles from geometry', () => {
    // East, then a 40° right bend, a 90° left, and a sharp 150° right.
    const r = makeRoute([4.9, 52.37], [
      [90, 200],
      [130, 200],
      [40, 200],
      [190, 200],
    ]);
    expect(r.maneuvers.map((m) => Math.round(m.angle))).toEqual([40, -90, 150]);
    expect(r.maneuvers[0].along).toBeCloseTo(200, -1);
    expect(r.length).toBeCloseTo(800, 0);
  });

  it('drops gentle bends below the threshold', () => {
    const r = makeRoute([4.9, 52.37], [
      [90, 200],
      [100, 200],
    ]);
    expect(r.maneuvers).toHaveLength(0);
  });

  it('describes angles', () => {
    expect(describeAngle(40)).toBe('slight right');
    expect(describeAngle(-90)).toBe('left');
    expect(describeAngle(150)).toBe('sharp right');
    expect(describeAngle(-175)).toBe('U-turn');
  });
});
