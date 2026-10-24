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
3. Listen. The default **Ambient chimes** style uses soft bell tones with a little reverb, all on a pentatonic scale:
   - **Chime**: you're off course. It comes from the direction to go. Like a piano keyboard, the further **right** you need to go, the **higher** the note, and the further **left**, the **lower**.
     - A deviation must last over a second before chimes start (unless it's large), so swaying doesn't trigger them.
     - On a curving road, "on course" means following the road's own direction where you are, so walking an arc stays quiet.
   - **Faint droplet**, about every 6 s: you're on course (within ±15°).
   - **Deep low gong**: the route is behind you. The side it comes from is the way to turn.
   - **Rattle ("trrk-trrk")**: a turn is coming.
     - It's a dry, woodblock-like rattle from the turn's real direction, with the second strike **higher for a right turn, lower for a left turn**.
     - It speeds up like a parking sensor (sparse → rapid), climbs in pitch and swells as you approach.
     - A soft open chord resolves it once you're through the turn.
   - **Two falling, slightly clouded notes**: you're off the route. A new route is planned automatically, and a soft rising arpeggio confirms it.
   - **Long pentatonic arpeggio**: you've arrived.

   All of this sits inside a continuous **soundscape** (adjust it with the Background slider):
   - **Pad**: a soft, slowly breathing chord in the same key as the chimes. It breathes faster as you go faster and darkens as you turn off course. Off route, the chord drifts to an unresolved, suspended harmony, and it resolves again once you're back on route.
   - **Breeze**: an airy layer that always comes *from the direction to go*. It's faint when you're on course and grows as you turn away. Turn it off with the "Directional breeze" checkbox.
   - The background dips briefly under each chime, so the chimes sit inside it.

   **Junctions** (Route panel): where the route goes *straight* through a junction that has other ways to go, you hear **"keep straight"** once: two level notes from straight ahead (in the piano metaphor, up = right, down = left, level = straight on).
   - Choose between "at forks" (default: only where another branch is within 50° of your way, so easy to take by mistake; you then hear three notes), "at every junction", or off.
   - On the map, junctions with a cue are marked with small dots, violet at forks.

   **Map-matching** (Route panel, "Snap GPS to streets"): snaps the GPS position onto the street network from OpenStreetMap. The streets around the route load in about 20 s. Each nearby street is scored on:
   - distance, compared with the GPS accuracy;
   - whether it runs in your direction of travel;
   - continuity: reaching a parallel street over the network would mean a detour via a junction, so it's penalized;
   - a bonus for the planned route.

   The matched street's direction also steadies your heading. On the map, the grey dot is the raw GPS position and the blue ring is the matched one. In the simulator, test it with **N** (GPS noise).

   **Directionality** (Sound panel):
   - **Binaural** panning (default) gives each ear what it would get from a real source: a sub-millisecond delay, plus the far ear quieter and muffled. This lateralizes much more strongly than plain stereo.
   - **Direction emphasis** exaggerates angles (default 1.6×), so a 20° deviation already sounds clearly to one side.
   - **Test directions** plays left, ahead, right and behind.

   When the situation changes (you drift off course, for example), the cue switches right away instead of waiting out the slow ambient rhythm.
4. Tune everything in the **Sound** panel. Compare the schemes (Beacon / Continuous tone / Events only) and the styles (Ambient chimes / Classic beeps).

## On your phone (live GPS)

The app is deployed to **https://dionzand.github.io/sonarnav/** on every push to `main`, via GitHub Actions (tests, build, Pages).

1. Open the URL in **Safari** on the iPhone. Optionally tap Share → **Add to Home Screen** to get a full-screen app.
2. Plug in headphones. Stereo direction needs both ears.
3. Tap **Use live GPS** and allow **Location** and **Motion & Orientation** (the compass). That same tap also starts the audio.
4. Search a destination in **To** (or tap the map), then start walking or cycling.

**Heading from** (shown in live mode):
- **Direction of travel** (default): your real walking or cycling direction from GPS, for a phone in your pocket. It needs a few metres of movement. When you stop, it keeps the last known direction.
- **Compass**: the way the top of the phone points. Only for a phone held in your hand or mounted on the handlebar.
- **Auto**: compass when you're standing, GPS direction from walking speed upward.

**Map:**
- Drag, pinch or rotate the map freely. Tap **Follow me** to snap back to your position.
- Tapping the map opens a small menu (**Navigate here**). Nothing happens without confirming.
- **Hide settings** shrinks the panel to a slim bar.

**Pocket mode** blacks out the screen and ignores touches, so the phone can stay in your pocket with the page still running. Hold the screen for 1.5 s, or tap it 4 times quickly, to exit.

**Known limits of the web version**
- **Don't lock the phone.** iOS pauses web pages when the screen locks, which stops GPS and sound. Use pocket mode instead. Navigating with a locked phone needs a native app, which is the planned next step.
- Sound plays even with the silent switch on (Safari 16.4+).
- GPS in cities is typically ±5–15 m. The HUD shows the current accuracy.

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
