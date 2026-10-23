import { describe, expect, it } from 'vitest';
import { LngLat, angleDiff, bearing, cumulativeDistances, destination, distance, normalize180, pointAlong, projectOnLine } from '../src/core/geo';

const A: LngLat = [4.9, 52.37];

describe('geo', () => {
  it('destination and distance agree', () => {
    for (const brg of [0, 45, 90, 200, 315]) {
      const b = destination(A, brg, 250);
      expect(distance(A, b)).toBeCloseTo(250, 3);
      expect(angleDiff(brg, bearing(A, b))).toBeCloseTo(0, 1);
    }
  });

  it('known distance: 1° of latitude ≈ 111.2 km', () => {
    expect(distance([0, 0], [0, 1]) / 1000).toBeCloseTo(111.19, 1);
  });

  it('normalizes and diffs angles', () => {
    expect(normalize180(190)).toBe(-170);
    expect(normalize180(-190)).toBe(170);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(Math.abs(angleDiff(0, 180))).toBe(180);
  });

  it('projects onto a polyline', () => {
    const b = destination(A, 90, 100);
    const c = destination(b, 0, 100);
    const p = destination(destination(A, 90, 40), 0, 5); // 5 m north of the first segment
    const proj = projectOnLine(p, [A, b, c]);
    expect(proj.segment).toBe(0);
    expect(proj.distance).toBeCloseTo(5, 0);
    expect(proj.along).toBeCloseTo(40, 0);
  });

  it('finds points along a polyline', () => {
    const b = destination(A, 90, 100);
    const c = destination(b, 0, 100);
    const line = [A, b, c];
    const cum = cumulativeDistances(line);
    const { point, segment } = pointAlong(line, cum, 150);
    expect(segment).toBe(1);
    expect(distance(point, destination(b, 0, 50))).toBeLessThan(0.5);
    expect(pointAlong(line, cum, -5).point).toEqual(A);
    expect(pointAlong(line, cum, 1e6).point).toEqual(c);
  });
});
