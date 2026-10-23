import './styles.css';
import { LngLat, bearing, normalize360 } from './core/geo';
import { DEFAULT_NAV, NavSettings, NavState, Navigator } from './core/navigator';
import { Profile, Route, describeAngle } from './core/route';
import { AudioEngine } from './audio/engine';
import { AudioSettings, DEFAULT_AUDIO } from './audio/mapping';
import { SCHEMES } from './audio/schemes';
import { OsrmRouter } from './routing/osrm';
import { reverseGeocode } from './geocode/nominatim';
import { Simulator, SNAP_MODES, SnapMode } from './position/simulator';
import { NoisyGps } from './position/gpsNoise';
import { fetchStreets } from './position/streets';
import { MapView, CameraMode } from './ui/map';
import { renderHud, cardinal, fmtDist } from './ui/hud';
import { announce, setSpeech } from './ui/a11y';
import { attachSearch } from './ui/search';

// ---------- persisted settings (per browser; safe if storage is unavailable) ----------
// v2: new ambient defaults (lower pitch); don't carry over v1's 880 Hz.
const STORE_KEY = 'sonarnav.v2';
interface Saved {
  audio?: Partial<AudioSettings>;
  nav?: Partial<Record<Profile, Partial<NavSettings>>>;
  scheme?: string;
  profile?: Profile;
  position?: LngLat;
  speech?: boolean;
}
function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
function save(): void {
  try {
    const s: Saved = { audio: audioSettings, nav: navSettings, scheme: audio.scheme.id, profile: sim.profile, position: sim.position, speech: speechBox.checked };
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}
const saved = load();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
const AMSTERDAM: LngLat = [4.8936, 52.3731];
const audioSettings: AudioSettings = {
  ...DEFAULT_AUDIO,
  ...saved.audio,
  turnWarn: { ...DEFAULT_AUDIO.turnWarn, ...saved.audio?.turnWarn },
};
const navSettings: Record<Profile, NavSettings> = {
  foot: { ...DEFAULT_NAV.foot, ...saved.nav?.foot },
  bike: { ...DEFAULT_NAV.bike, ...saved.nav?.bike },
};

const sim = new Simulator(saved.position ?? AMSTERDAM);
sim.profile = saved.profile ?? 'bike';
const gps = new NoisyGps(sim);
const router = new OsrmRouter();
const audio = new AudioEngine(audioSettings, SCHEMES.find((s) => s.id === saved.scheme) ?? SCHEMES[0], () => sim.profile);

let route: Route | null = null;
let nav: Navigator | null = null;
let navState: NavState | null = null;
let fromPos: LngLat | null = null;
let destination: LngLat | null = null;
let rerouting = false;
let lastReroute = 0;

const map = new MapView($('map'), sim.position, {
  onClick(p, mods) {
    if (mods.ctrl) {
      sim.face(p);
      announce(`Facing ${Math.round(sim.heading)} degrees`);
    } else {
      setDestination(p, 'map point');
      void planRoute();
    }
  },
  onRightClick(p) {
    sim.teleport(p);
    fromPos = null;
    $<HTMLInputElement>('from').value = '';
    announce('Moved to clicked point');
    if (destination) void planRoute();
  },
});

// ---------- routing ----------
function setDestination(p: LngLat, label: string): void {
  destination = p;
  map.showDestination(p);
  if (label !== 'map point') return;
  $<HTMLInputElement>('to').value = `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
}

async function planRoute(opts: { reroute?: boolean } = {}): Promise<void> {
  if (!destination) {
    announce('Choose a destination first: search in the To field, or click the map.');
    $<HTMLInputElement>('to').focus();
    return;
  }
  if (fromPos && !opts.reroute) {
    sim.teleport(fromPos);
    fromPos = null;
  }
  const summary = $('route-summary');
  summary.textContent = opts.reroute ? 'Rerouting…' : 'Planning…';
  try {
    const r = await router.route({
      from: sim.position,
      to: destination,
      profile: sim.profile,
      heading: opts.reroute ? sim.heading : undefined,
    });
    route = r;
    sim.route = r;
    if (nav) {
      nav.settings = navSettings[sim.profile];
      nav.setRoute(r);
    } else nav = new Navigator(r, navSettings[sim.profile]);
    map.showRoute(r);
    if (!opts.reroute && r.geometry.length > 1) sim.setHeading(bearing(r.geometry[0], r.geometry[Math.min(2, r.geometry.length - 1)]));
    const mins = Math.max(1, Math.round(r.duration / 60));
    const text = `${fmtDist(r.length)}, about ${mins} min by ${sim.profile === 'bike' ? 'bike' : 'foot'}, ${r.maneuvers.length} turns.`;
    summary.textContent = text;
    if (opts.reroute) {
      audio.event('rerouted');
      announce(`New route. ${text}`);
    } else {
      announce(`Route ready. ${text} Press up arrow to start moving.`);
    }
    if (sim.snapMode === 'streets') void loadStreets();
  } catch (e) {
    summary.textContent = `Routing failed: ${(e as Error).message}`;
    announce(summary.textContent);
  }
}

function clearRoute(): void {
  route = nav = navState = null;
  sim.route = null;
  destination = null;
  map.showRoute(null);
  map.showDestination(null);
  $<HTMLInputElement>('to').value = '';
  $('route-summary').textContent = 'No route yet.';
  announce('Route cleared');
}

async function loadStreets(): Promise<void> {
  const pts = route?.geometry ?? [sim.position];
  const pad = 0.004;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  // Overpass gets slow on huge areas; cap at ~0.15° per side.
  if (e - w > 0.15 || n - s > 0.15) {
    announce('Route too long to load all streets; loading around your position.');
    [w, s, e, n] = [sim.position[0], sim.position[1], sim.position[0], sim.position[1]];
  }
  announce('Loading streets…');
  try {
    sim.streets = await fetchStreets([w - pad, s - pad, e + pad, n + pad]);
    announce(`Snapping to ${sim.streets.size} street segments`);
  } catch (err) {
    announce(`Could not load streets: ${(err as Error).message}`);
  }
}

// ---------- panel wiring ----------
attachSearch($('from'), $('from-results'), () => map.center(), (p) => {
  fromPos = p.position;
  sim.teleport(p.position);
  announce(`Start set to ${p.label}`);
});
attachSearch($('to'), $('to-results'), () => sim.position, (p) => {
  setDestination(p.position, p.label);
  void planRoute();
});
$('plan').addEventListener('click', () => void planRoute());
$('clear').addEventListener('click', clearRoute);

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=profile]')) {
  radio.checked = radio.value === sim.profile;
  radio.addEventListener('change', () => {
    sim.profile = radio.value as Profile;
    syncSliders();
    save();
    if (destination) void planRoute({ reroute: true });
  });
}

const snapSel = $<HTMLSelectElement>('snap');
function setSnap(mode: SnapMode): void {
  sim.snapMode = mode;
  snapSel.value = mode;
  announce(`Snap: ${snapSel.selectedOptions[0].text}`);
  if (mode === 'streets' && !sim.streets) void loadStreets();
}
snapSel.addEventListener('change', () => setSnap(snapSel.value as SnapMode));

const camSel = $<HTMLSelectElement>('camera');
camSel.addEventListener('change', () => (map.camera = camSel.value as CameraMode));

const noiseBox = $<HTMLInputElement>('noise');
noiseBox.addEventListener('change', () => (gps.enabled = noiseBox.checked));

const headingInput = $<HTMLInputElement>('heading-input');
const applyHeading = () => {
  sim.setHeading(Number(headingInput.value) || 0);
  announce(`Heading ${Math.round(sim.heading)} degrees`);
};
$('heading-set').addEventListener('click', applyHeading);
headingInput.addEventListener('keydown', (e) => e.key === 'Enter' && applyHeading());

const schemeSel = $<HTMLSelectElement>('scheme');
for (const s of SCHEMES) schemeSel.add(new Option(s.name, s.id));
schemeSel.value = audio.scheme.id;
const showSchemeDesc = () => ($('scheme-desc').textContent = audio.scheme.description);
showSchemeDesc();
schemeSel.addEventListener('change', () => {
  audio.setScheme(SCHEMES.find((s) => s.id === schemeSel.value)!);
  showSchemeDesc();
  save();
});

interface SliderSpec {
  id: string;
  get(): number;
  set(v: number): void;
  fmt?(v: number): string;
}
const sliders: SliderSpec[] = [
  { id: 'volume', get: () => audioSettings.volume, set: (v) => audio.setVolume(v), fmt: (v) => `${Math.round(v * 100)}%` },
  { id: 'deadzone', get: () => audioSettings.deadZone, set: (v) => (audioSettings.deadZone = v), fmt: (v) => `${v}°` },
  { id: 'rate', get: () => audioSettings.rate, set: (v) => (audioSettings.rate = v), fmt: (v) => `${v.toFixed(1)}×` },
  { id: 'pitch', get: () => audioSettings.basePitch, set: (v) => (audioSettings.basePitch = v) },
  { id: 'lookahead', get: () => navSettings[sim.profile].lookaheadMin, set: (v) => (navSettings[sim.profile].lookaheadMin = v), fmt: (v) => `${v} m` },
  { id: 'turnwarn', get: () => audioSettings.turnWarn[sim.profile], set: (v) => (audioSettings.turnWarn[sim.profile] = v), fmt: (v) => `${v} m` },
];
function syncSliders(): void {
  for (const s of sliders) {
    const input = $<HTMLInputElement>(s.id);
    input.value = String(s.get());
    (input.nextElementSibling as HTMLOutputElement).value = s.fmt ? s.fmt(s.get()) : String(s.get());
  }
}
for (const s of sliders) {
  const input = $<HTMLInputElement>(s.id);
  input.addEventListener('input', () => {
    s.set(Number(input.value));
    (input.nextElementSibling as HTMLOutputElement).value = s.fmt ? s.fmt(Number(input.value)) : input.value;
    save();
  });
}
syncSliders();

const styleSel = $<HTMLSelectElement>('style');
styleSel.value = audioSettings.style;
styleSel.addEventListener('change', () => {
  audio.setStyle(styleSel.value as AudioSettings['style']);
  save();
});

const panSel = $<HTMLSelectElement>('panmode');
panSel.value = audioSettings.panMode;
panSel.addEventListener('change', () => {
  audioSettings.panMode = panSel.value as AudioSettings['panMode'];
  save();
});
const silentBox = $<HTMLInputElement>('silent-aligned');
silentBox.checked = audioSettings.silentWhenAligned;
silentBox.addEventListener('change', () => {
  audioSettings.silentWhenAligned = silentBox.checked;
  save();
});
const speechBox = $<HTMLInputElement>('speech');
speechBox.checked = !!saved.speech;
setSpeech(speechBox.checked);
speechBox.addEventListener('change', () => {
  setSpeech(speechBox.checked);
  save();
});

const startBtn = $<HTMLButtonElement>('audio-start');
async function startAudio(): Promise<void> {
  await audio.start();
  startBtn.textContent = 'Audio on';
  startBtn.setAttribute('aria-pressed', 'true');
  announce('Audio on. Press T for a direction test.');
}
startBtn.addEventListener('click', () => void startAudio());

// ---------- keyboard ----------
const KEYS: [string, string][] = [
  ['↑ / ↓', 'Speed up / slow down (speed holds when released)'],
  ['← / →', 'Steer (hold longer to turn faster)'],
  ['Shift + ← / →', 'Turn exactly 15°'],
  ['B', 'Turn around (180°)'],
  ['F', 'Face the beacon (point ahead on the route)'],
  ['X', 'Stop'],
  ['Space', 'Pause / resume'],
  ['Ctrl + click', 'Face the clicked point'],
  ['Click', 'Set destination and plan'],
  ['Right-click', 'Move yourself there'],
  ['R', 'Re-plan the route from here'],
  ['S', 'Cycle snap mode (off / route / streets)'],
  ['C', 'Cycle camera (heading-up / north-up / free)'],
  ['N', 'Toggle GPS noise'],
  ['Enter', 'Start audio'],
  ['M', 'Mute / unmute'],
  ['T', 'Test sweep: left, half-left, ahead, half-right, right, behind'],
  ['W', 'Where am I (spoken)'],
  ['L', 'Next turn (spoken)'],
  ['Esc', 'Leave a text field and go back to driving'],
  ['?', 'This help'],
];
for (const id of ['keys', 'help-keys']) {
  $(id).innerHTML = KEYS.map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
}

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

async function whereAmI(): Promise<void> {
  const parts = [`Heading ${cardinal(sim.heading)}, ${Math.round(sim.heading)} degrees`];
  if (navState) {
    parts.push(navState.offRoute ? 'Off route' : `${fmtDist(navState.remaining)} to go`);
  }
  const place = await reverseGeocode(sim.position).catch(() => null);
  if (place) parts.unshift(place);
  announce(parts.join('. '), { speak: true });
}

function nextTurn(): void {
  if (!navState) return announce('No route', { speak: true });
  const n = navState.next;
  announce(
    n ? `In ${fmtDist(navState.distanceToNext)}, ${describeAngle(n.angle)}, ${Math.round(Math.abs(n.angle))} degrees${n.name ? ` onto ${n.name}` : ''}` : `Destination in ${fmtDist(navState.distanceToNext)}`,
    { speak: true },
  );
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isTyping(e.target)) {
    (e.target as HTMLElement).blur();
    announce('Driving mode');
    return;
  }
  if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = ARROWS[e.key];
  if (dir) {
    e.preventDefault();
    if (e.shiftKey && (dir === 'left' || dir === 'right')) {
      if (!e.repeat) sim.turnBy(dir === 'right' ? 15 : -15);
    } else sim.press(dir);
    return;
  }
  if (e.repeat) return;
  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      sim.paused = !sim.paused;
      announce(sim.paused ? 'Paused' : 'Resumed');
      break;
    case 'b':
      sim.turnBy(180);
      break;
    case 'f':
      if (navState) sim.face(navState.beacon);
      break;
    case 'x':
      sim.stop();
      break;
    case 'r':
      void planRoute({ reroute: true });
      break;
    case 's':
      setSnap(SNAP_MODES[(SNAP_MODES.indexOf(sim.snapMode) + 1) % SNAP_MODES.length]);
      break;
    case 'c': {
      const modes: CameraMode[] = ['heading', 'north', 'free'];
      map.camera = modes[(modes.indexOf(map.camera) + 1) % modes.length];
      camSel.value = map.camera;
      announce(`Camera: ${camSel.selectedOptions[0].text}`);
      break;
    }
    case 'n':
      gps.enabled = noiseBox.checked = !gps.enabled;
      announce(`GPS noise ${gps.enabled ? 'on' : 'off'}`);
      break;
    case 'enter':
      void startAudio();
      break;
    case 'm':
      audio.setMuted(!audio.muted);
      announce(audio.muted ? 'Muted' : 'Unmuted');
      break;
    case 't':
      if (!audio.running) void startAudio().then(() => audio.testSweep());
      else audio.testSweep();
      break;
    case 'w':
      void whereAmI();
      break;
    case 'l':
      nextTurn();
      break;
    case '?':
      $<HTMLDialogElement>('help').showModal();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  const dir = ARROWS[e.key];
  if (dir) sim.release(dir);
});
window.addEventListener('blur', () => sim.releaseAll());

// ---------- main loop ----------
let lastFrame = performance.now();
let lastHud = 0;
let lastSave = 0;

function handleEvents(state: NavState): void {
  for (const ev of state.events) {
    if (ev === 'offRoute') {
      audio.event('offRoute');
      announce('Off route');
      const now = performance.now();
      if (destination && !rerouting && now - lastReroute > 4000) {
        rerouting = true;
        lastReroute = now;
        void planRoute({ reroute: true }).finally(() => (rerouting = false));
      }
    } else if (ev === 'backOnRoute') {
      audio.event('backOnRoute');
      announce('Back on route');
    } else if (ev === 'arrived') {
      audio.event('arrived');
      announce('You have arrived', { speak: true });
    } else if (ev === 'maneuverPassed') {
      audio.event('maneuverPassed');
    }
  }
}

// Simulation, navigation and audio run on a timer, not on animation frames: browsers
// throttle rAF to ~1 fps when the window is covered, and you should be able to keep
// listening with the map hidden behind other windows.
function step(): void {
  const now = performance.now();
  let dt = Math.min(0.5, (now - lastFrame) / 1000);
  lastFrame = now;
  while (dt > 0) {
    const h = Math.min(dt, 0.05);
    sim.tick(h);
    dt -= h;
  }
  const fix = gps.current(now / 1000);
  if (nav && route && fix) {
    navState = nav.update(fix.position, normalize360(fix.heading), fix.speed, now / 1000);
    handleEvents(navState);
  } else {
    navState = null;
  }
  audio.setState(navState);
}
setInterval(step, 20);

function frame(now: number): void {
  if (route && navState) map.updateManeuvers(route, navState.next ? route.maneuvers.indexOf(navState.next) : -1);
  map.updateWalker(sim.position, sim.heading);
  map.updateNav(navState);

  if (now - lastHud > 100) {
    lastHud = now;
    if (document.activeElement !== headingInput) headingInput.value = String(Math.round(sim.heading));
    renderHud($('hud'), {
      heading: sim.heading,
      speed: sim.speed,
      snap: sim.snapMode,
      noise: gps.enabled,
      paused: sim.paused,
      audioOn: audio.running,
      muted: audio.muted,
      state: navState,
      guidance: audio.lastGuidance,
      maneuver: audio.lastManeuver,
    });
  }
  if (now - lastSave > 5000) {
    lastSave = now;
    save();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
