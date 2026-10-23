import { LngLat } from '../core/geo';

// Nominatim usage policy: at most 1 request per second.
let last = 0;

/** Short "street, area" description of a position, or null. */
export async function reverseGeocode(p: LngLat): Promise<string | null> {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const params = new URLSearchParams({ lat: String(p[1]), lon: String(p[0]), format: 'jsonv2', zoom: '17' });
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { address?: Record<string, string> };
  const a = data.address;
  if (!a) return null;
  const street = a.road ?? a.pedestrian ?? a.cycleway ?? a.footway ?? a.path;
  const area = a.suburb ?? a.neighbourhood ?? a.city ?? a.town ?? a.village;
  return [street, area].filter(Boolean).join(', ') || null;
}
