import { NavState } from '../core/navigator';
import { describeAngle } from '../core/route';
import { Cue } from '../audio/mapping';
import { ToneParams } from '../audio/schemes';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const cardinal = (deg: number) => CARDINALS[Math.round(deg / 45) % 8];

export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const signed = (deg: number) => `${deg > 0 ? '+' : ''}${Math.round(deg)}°`;

export interface HudInfo {
  heading: number;
  speed: number;
  snap: string;
  noise: boolean;
  paused: boolean;
  live?: { accuracy: number | null; source: 'compass' | 'course' | null; fixAge: number; waiting: boolean };
  audioOn: boolean;
  muted: boolean;
  state: NavState | null;
  guidance: Cue | ToneParams | null;
  maneuver: Cue | null;
}

/** Relative dial: up = the way you face. Green = beacon, orange = next turn's direction. */
function dial(state: NavState | null): string {
  const R = 46;
  const dot = (angle: number, r: number, fill: string, size: number) => {
    const rad = (angle * Math.PI) / 180;
    return `<circle cx="${60 + Math.sin(rad) * r}" cy="${60 - Math.cos(rad) * r}" r="${size}" fill="${fill}"/>`;
  };
  let marks = '';
  if (state) {
    marks += dot(state.relBearing, R, '#2fbf71', 7);
    if (state.next) {
      // Turn direction in your frame: where the route goes after the corner.
      const routeRel = state.routeBearing - state.heading + state.next.angle;
      marks += dot(routeRel, R - 16, '#ffb84d', 5);
    }
  }
  return `<svg width="120" height="120" viewBox="0 0 120 120">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    <path d="M60 22 L68 44 L60 39 L52 44 Z" fill="#f2f4f7"/>
    <line x1="60" y1="60" x2="60" y2="14" stroke="rgba(255,255,255,.15)"/>
    ${marks}
  </svg>`;
}

export function renderHud(el: HTMLElement, h: HudInfo): void {
  const st = h.state;
  const rows: [string, string][] = [
    ['heading', `${Math.round(h.heading)}° ${cardinal(h.heading)}`],
    ['speed', `${(h.speed * 3.6).toFixed(1)} km/h${h.paused ? ' <span class="warn">paused</span>' : ''}`],
    ['snap', `${h.snap}${h.noise ? ' · gps noise' : ''}`],
  ];
  if (h.live) {
    const l = h.live;
    const acc = l.accuracy === null ? '—' : `±${Math.round(l.accuracy)} m`;
    const stale = l.fixAge > 5 ? ` <span class="warn">${Math.round(l.fixAge)} s old</span>` : '';
    rows.splice(2, 1, ['gps', l.waiting ? '<span class="warn">waiting for fix…</span>' : `${acc}${stale}`], ['heading by', l.source ?? '—']);
  }
  if (st) {
    rows.push(
      ['beacon', `${signed(st.relBearing)} · ${fmtDist(st.distanceToBeacon)}`],
      ['off line', `<span class="${st.offRoute ? 'bad' : st.crossTrack > 8 ? 'warn' : ''}">${fmtDist(st.crossTrack)}${st.offRoute ? ' OFF ROUTE' : ''}</span>`],
      ['next', st.next ? `${signed(st.next.angle)} ${describeAngle(st.next.angle)} in ${fmtDist(st.distanceToNext)}` : `arrive in ${fmtDist(st.distanceToNext)}`],
      ['onto', st.next?.name || '—'],
      ['left', st.arrived ? '<span class="good">arrived</span>' : fmtDist(st.remaining)],
    );
  }
  const g = h.guidance;
  const m = h.maneuver;
  const audio = !h.audioOn
    ? '<span class="warn">sound off (button top left, or Enter)</span>'
    : h.muted
      ? '<span class="warn">sound off</span>'
      : g
        ? 'kind' in g
          ? `${g.kind} ${Math.round(g.freq)} Hz · ${g.timbre} · every ${g.interval.toFixed(2)} s`
          : `tone ${Math.round(g.freq)} Hz · ${g.timbre}`
        : 'silent';
  rows.push(['sound', audio]);
  if (m) rows.push(['turn cue', `${Math.round(m.freq)}→${Math.round(m.freq2 ?? m.freq)} Hz · every ${m.interval.toFixed(1)} s · vol ${Math.round((m.gain / 0.63) * 100)}%`]);

  const pans = [g ? `<i style="left:${((g.pan + 1) / 2) * 100}%"></i>` : '', m ? `<i class="turn" style="left:${((m.pan + 1) / 2) * 100}%"></i>` : ''].join('');

  el.innerHTML = `${dial(st)}
    <div class="panbar" title="stereo pan">${pans}</div>
    <div class="grid">${rows.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('')}</div>`;
}
