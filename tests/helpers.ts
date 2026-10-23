import { LngLat, destination } from '../src/core/geo';
import { RawStep, buildRoute } from '../src/core/route';

/** Build a route from legs of [bearing, metres], with OSRM-like steps at each corner. */
export function makeRoute(start: LngLat, legs: [number, number][]) {
  const geometry: LngLat[] = [start];
  const steps: RawStep[] = [{ location: start, type: 'depart', name: '' }];
  let p = start;
  legs.forEach(([brg, len], i) => {
    // Densify so the geometry looks like a real router's output.
    const n = Math.max(1, Math.round(len / 10));
    for (let k = 0; k < n; k++) {
      p = destination(p, brg, len / n);
      geometry.push(p);
    }
    steps.push({ location: p, type: i === legs.length - 1 ? 'arrive' : 'turn', name: `street ${i + 1}` });
  });
  return buildRoute('bike', geometry, steps, 600);
}
