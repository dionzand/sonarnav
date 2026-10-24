import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { LngLat } from '../core/geo';
import { NavState } from '../core/navigator';
import { Route } from '../core/route';

export type CameraMode = 'heading' | 'north' | 'free';

// MapLibre v6 ships its tile worker as a separate module; tell it where Vite put it.
maplibregl.setWorkerUrl(workerUrl);

const STYLE ='https://tiles.openfreemap.org/styles/liberty';

const ARROW_SVG = `<svg class="walker" viewBox="0 0 34 34" aria-hidden="true">
  <circle cx="17" cy="17" r="15" fill="#0b6bcb" fill-opacity="0.18"/>
  <path d="M17 3 L26 27 L17 21 L8 27 Z" fill="#0b6bcb" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export interface MapHandlers {
  onClick(p: LngLat, e: { ctrl: boolean; shift: boolean }): void;
  onRightClick(p: LngLat): void;
  /** The camera mode changed (e.g. you dragged the map, so following stopped). */
  onCameraChange(mode: CameraMode): void;
}

export interface MapAction {
  label: string;
  primary?: boolean;
  run(): void;
}

export class MapView {
  readonly map: MlMap;
  private walker: Marker;
  private walkerEl: HTMLElement;
  private ready: Promise<void>;
  private _camera: CameraMode = 'heading';
  /** The follow mode to return to with "recenter". */
  followMode: Exclude<CameraMode, 'free'> = 'heading';
  /** Pointers currently on the map: while any are down, following pauses so gestures aren't cut off. */
  private pointers = new Set<number>();
  private popup: maplibregl.Popup | null = null;

  get camera(): CameraMode {
    return this._camera;
  }

  set camera(mode: CameraMode) {
    if (mode === this._camera) return;
    this._camera = mode;
    if (mode !== 'free') this.followMode = mode;
    this.handlers.onCameraChange(mode);
  }

  constructor(
    container: HTMLElement,
    center: LngLat,
    private handlers: MapHandlers,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE,
      center,
      zoom: 16.5,
      pitch: 0,
      attributionControl: { compact: true },
      // Arrow keys belong to the simulator.
      keyboard: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.walkerEl = document.createElement('div');
    this.walkerEl.innerHTML = ARROW_SVG;
    this.walker = new maplibregl.Marker({ element: this.walkerEl, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat(center)
      .addTo(this.map);

    this.map.on('click', (e) =>
      handlers.onClick([e.lngLat.lng, e.lngLat.lat], { ctrl: e.originalEvent.ctrlKey || e.originalEvent.metaKey, shift: e.originalEvent.shiftKey }),
    );
    this.map.on('contextmenu', (e) => {
      e.preventDefault();
      handlers.onRightClick([e.lngLat.lng, e.lngLat.lat]);
    });
    // Following calls jumpTo every frame, which would cancel any gesture in progress.
    // So: pause following while a finger/mouse is down, and once you actually pan,
    // zoom or rotate, hand the camera to you (a "Follow me" button brings it back).
    const canvas = this.map.getCanvasContainer();
    canvas.addEventListener('pointerdown', (e) => this.pointers.add(e.pointerId));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      canvas.addEventListener(type, (e) => this.pointers.delete(e.pointerId));
    }
    canvas.addEventListener('wheel', () => (this.camera = 'free'), { passive: true });
    for (const type of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      this.map.on(type, (e: { originalEvent?: Event }) => {
        if (e.originalEvent) this.camera = 'free';
      });
    }

    this.ready = new Promise((resolve) => {
      this.map.on('load', () => {
        this.addLayers();
        resolve();
      });
    });
  }

  private addLayers(): void {
    const m = this.map;
    for (const id of ['route', 'beacon', 'maneuvers', 'snapped', 'destination']) {
      m.addSource(id, { type: 'geojson', data: empty() });
    }
    m.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9 },
    });
    m.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b6bcb', 'line-width': 5 },
    });
    m.addLayer({
      id: 'maneuvers',
      type: 'circle',
      source: 'maneuvers',
      paint: {
        'circle-radius': ['case', ['get', 'next'], 8, 5],
        'circle-color': ['case', ['get', 'next'], '#ff9e1b', '#ffffff'],
        'circle-stroke-color': '#0b6bcb',
        'circle-stroke-width': 2,
      },
    });
    m.addLayer({
      id: 'maneuver-labels',
      type: 'symbol',
      source: 'maneuvers',
      layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-font': ['Noto Sans Regular'] },
      paint: { 'text-color': '#15181d', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
    m.addLayer({
      id: 'destination',
      type: 'circle',
      source: 'destination',
      paint: { 'circle-radius': 9, 'circle-color': '#d4380d', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
    });
    m.addLayer({
      id: 'snapped',
      type: 'circle',
      source: 'snapped',
      paint: { 'circle-radius': 3, 'circle-color': '#0b6bcb' },
    });
    m.addLayer({
      id: 'beacon',
      type: 'circle',
      source: 'beacon',
      paint: {
        'circle-radius': 7,
        'circle-color': '#2fbf71',
        'circle-opacity': 0.85,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
  }

  private async setData(id: string, data: GeoJSON.FeatureCollection | GeoJSON.Feature): Promise<void> {
    await this.ready;
    (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  }

  showRoute(route: Route | null): void {
    if (!route) {
      for (const id of ['route', 'maneuvers', 'beacon', 'snapped']) void this.setData(id, empty());
      return;
    }
    void this.setData('route', { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.geometry } });
    this.updateManeuvers(route, -1);
  }

  private nextShown = -2;
  updateManeuvers(route: Route, nextIndex: number): void {
    if (nextIndex === this.nextShown) return;
    this.nextShown = nextIndex;
    void this.setData('maneuvers', {
      type: 'FeatureCollection',
      features: route.maneuvers.map((m, i) => ({
        type: 'Feature',
        properties: { next: i === nextIndex, label: `${m.angle > 0 ? '+' : ''}${Math.round(m.angle)}°` },
        geometry: { type: 'Point', coordinates: m.location },
      })),
    });
  }

  showDestination(p: LngLat | null): void {
    void this.setData('destination', p ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } } : empty());
  }

  updateWalker(position: LngLat, heading: number): void {
    this.walker.setLngLat(position);
    this.walker.setRotation(heading);
    if (this.pointers.size > 0) return;
    if (this._camera === 'heading') this.map.jumpTo({ center: position, bearing: heading });
    else if (this._camera === 'north') this.map.jumpTo({ center: position, bearing: 0 });
  }

  /** A small popup at `p` offering explicit choices (instead of acting on a bare tap). */
  showChoice(p: LngLat, title: string, actions: MapAction[]): void {
    this.popup?.remove();
    const el = document.createElement('div');
    el.className = 'choice';
    const h = document.createElement('p');
    h.textContent = title;
    el.appendChild(h);
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', () => {
        this.popup?.remove();
        a.run();
      });
      el.appendChild(b);
    }
    this.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '240px', focusAfterOpen: true })
      .setLngLat(p)
      .setDOMContent(el)
      .addTo(this.map);
  }

  closeChoice(): void {
    this.popup?.remove();
  }

  updateNav(state: NavState | null): void {
    if (!state) return;
    void this.setData('beacon', { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: state.beacon } });
    void this.setData('snapped', { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: state.snapped } });
  }

  center(): LngLat {
    const c = this.map.getCenter();
    return [c.lng, c.lat];
  }
}
