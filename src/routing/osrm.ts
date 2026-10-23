import { LngLat } from '../core/geo';
import { RawStep, buildRoute } from '../core/route';
import { RouteRequest, Router } from './router';

// FOSSGIS-hosted OSRM with real bike/foot profiles (the project-osrm.org demo is car-only).
const BASE = 'https://routing.openstreetmap.de';
const PROFILE_PATH = { foot: 'routed-foot', bike: 'routed-bike' } as const;

interface OsrmResponse {
  code: string;
  message?: string;
  routes: {
    duration: number;
    geometry: { coordinates: LngLat[] };
    legs: { steps: { name: string; maneuver: { type: string; location: LngLat } }[] }[];
  }[];
}

export class OsrmRouter implements Router {
  async route(req: RouteRequest, signal?: AbortSignal) {
    const coords = `${req.from[0]},${req.from[1]};${req.to[0]},${req.to[1]}`;
    const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', steps: 'true' });
    if (req.heading !== undefined) params.set('bearings', `${Math.round(req.heading) % 360},90;`);
    const url = `${BASE}/${PROFILE_PATH[req.profile]}/route/v1/driving/${coords}?${params}`;
    const res = await fetch(url, { signal });
    const data = (await res.json()) as OsrmResponse;
    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || `No route found (${data.code})`);
    }
    const r = data.routes[0];
    const steps: RawStep[] = r.legs.flatMap((leg) =>
      leg.steps.map((s) => ({ location: s.maneuver.location, type: s.maneuver.type, name: s.name })),
    );
    return buildRoute(req.profile, r.geometry.coordinates, steps, r.duration);
  }
}
