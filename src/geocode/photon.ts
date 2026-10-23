import { LngLat } from '../core/geo';

export interface Place {
  label: string;
  position: LngLat;
}

interface PhotonFeature {
  geometry: { coordinates: LngLat };
  properties: Record<string, string | undefined>;
}

function label(p: PhotonFeature['properties']): string {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const parts = [p.name, street && street !== p.name ? street : undefined, p.city ?? p.town ?? p.village, p.country];
  return [...new Set(parts.filter(Boolean))].join(', ');
}

/** Forward search; `near` biases results towards the current map area. */
export async function searchPlaces(query: string, near?: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '6' });
  if (near) {
    params.set('lon', near[0].toFixed(5));
    params.set('lat', near[1].toFixed(5));
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return data.features.map((f) => ({ label: label(f.properties), position: f.geometry.coordinates }));
}
