# SonarNav — audio-cue navigation playground

Navigate by **sound instead of spoken directions**: stereo beeps whose pan, pitch and rhythm tell you the exact direction to go. A 40° bend sounds 40° off, not "turn right". Built for cyclists and pedestrians, with visually impaired users explicitly in mind.

This is the PC playground. You plan a real route on OpenStreetMap and walk or cycle it with the arrow keys while a simulated GPS position drives the audio engine.

## Run

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for geo math, navigator and cue mapping
```

Use **headphones**. Click **Start audio** (or press Enter), then press **T** for a direction test sweep.

## Try it

1. Type a destination in **To** (or click the map). The route is planned from your position (the blue arrow).
   Right-click the map to move yourself. **From** lets you search a start point.
2. Press **↑** to start moving. Speed holds when you release the key. Steer with **← / →**.
3. Listen:
   - **Beep**: comes from the direction of the green beacon dot, a point just ahead on the route. Higher pitch means you're closer to dead-on.
   - **Soft tick**: you're on course (inside the dead zone).
   - **Low buzz**: the route is behind you. The side it comes from is the way to turn.
   - **Two-tone chirp**: a turn is coming, sounded at the turn's real angle, and it repeats faster as you get close. If it glides down, it's a sharp turn.
   - **Noise burst**: you're off the route. A new route is planned automatically, and a chord confirms it.
   - **Rising arpeggio**: you've arrived.
4. Tune everything in the **Sound** panel and compare the schemes (Beacon / Continuous tone / Events only).

## Heading control

| Key | Action |
|---|---|
| ← / → | steer; holding speeds up the turn rate |
| Shift + ← / → | turn exactly 15° |
| B | turn around |
| F | face the beacon |
| Ctrl + click | face the clicked point |
| Heading field | type an exact compass heading |

All keys: press **?** in the app.

## Architecture

- `src/core/`: pure, DOM-free logic, meant to carry over to a phone app later
  - `geo.ts`: distances, bearings, polyline projection
  - `route.ts`: route model; turn angles computed from the geometry
  - `navigator.ts`: progress, look-ahead beacon, off-route detection, arrival
- `src/audio/`
  - `mapping.ts`: NavState → cue parameters (pure, tested)
  - `schemes.ts`: swappable cue designs; add one here and it shows up in the UI
  - `engine.ts` / `synth.ts`: Web Audio scheduling and synthesis (stereo or HRTF panning)
- `src/position/`
  - `simulator.ts`: keyboard walker
  - `gpsNoise.ts`: realistic 1 Hz jittery GPS
  - `streets.ts`: OSM street snapping
  - `provider.ts`: the `PositionSource` interface; a real-GPS source plugs in here
- `src/routing/osrm.ts`, `src/geocode/`: OSRM (routing.openstreetmap.de), Photon and Nominatim

## Accessibility

- Fully keyboard-operable, including the search comboboxes (↑/↓, Enter, Esc). Esc leaves a text field and returns to driving.
- Status messages go to an ARIA live region for screen readers. Built-in speech is optional (**W** where am I, **L** next turn).
- The map is optional; everything that matters is audible.

## Services used

Free public services: OSRM by FOSSGIS, Photon by Komoot, Nominatim, Overpass, and OpenFreeMap tiles. They're fine for personal testing; respect their usage policies. For heavier use, self-host OSRM, BRouter or GraphHopper behind the `Router` interface.
