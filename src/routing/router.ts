import { LngLat } from '../core/geo';
import { Profile, Route } from '../core/route';

export interface RouteRequest {
  from: LngLat;
  to: LngLat;
  profile: Profile;
  /** Current heading, so a reroute prefers continuing the way you face. */
  heading?: number;
}

export interface Router {
  route(req: RouteRequest, signal?: AbortSignal): Promise<Route>;
}
