# MBTA Train Jazz — Master Plan

**Vision (Max):** trainjazz.com, but for Boston. Live MBTA data becomes an ambient jazz
combo over a live map. Phase 1 is a localhost website for tuning; the end state is a
standalone Raspberry Pi + speaker appliance that plays it 24/7 (ideally running the
software directly, not just a browser pointed at a page — but browser-kiosk is the
accepted stepping stone). All modes wanted: subway, buses, commuter rail, ferries.

This document is the handoff artifact: everything researched, every design decision and
why, and the roadmap. Another model should be able to continue from here with zero
re-research.

---

## 1. Research findings (verified 2026-09-06)

### The reference: trainjazz.com (NYC)
- Built by Joshua Wolk. "Every train, a note."
- One **instrument per subway line**; each note is triggered by where a train is
  **along its route** right now. All active trains together form the combo.
- Started as a soundless live map; sound was layered on. Dark, minimal UI, live map,
  serif/editorial typography. No public source code found.
- Coverage: [NPR](https://www.npr.org/2026/08/09/nx-s1-5917185/a-website-makes-music-using-the-real-time-new-york-city-subway-schedule),
  [Fast Company](https://www.fastcompany.com/91534877/this-website-takes-the-cacophony-of-nycs-subway-and-turns-it-into-jazz-music).

### The data: MBTA V3 API — this is the whole ballgame
- Base: `https://api-v3.mbta.com` — JSON:API format. Docs: https://www.mbta.com/developers/v3-api
  and Swagger at https://api-v3.mbta.com/docs/swagger/index.html
- **Free API key** at https://api-v3.mbta.com (registration). 1,000 req/min with key;
  anonymous works too at ~20 req/min.
- **Streaming (the killer feature):** any of `/vehicles`, `/predictions`, `/alerts` can be
  consumed as **Server-Sent Events**. Send `Accept: text/event-stream` (browser
  `EventSource` does this automatically). **Requires an API key** (query param `api_key=`
  works, which is what EventSource needs since it can't set headers). Events:
  `reset` (full state array, sent first), then `add` / `update` / `remove` (single
  JSON:API resource each). The open connection counts as ONE request against rate limits.
  Docs: https://www.mbta.com/developers/v3-api/streaming
- **All modes in one endpoint** via GTFS `route_type`: 0 = light rail (Green, Mattapan),
  1 = heavy rail (Red/Orange/Blue), 2 = commuter rail (`CR-*`), 3 = bus, 4 = ferry (`Boat-*`).
  `GET /vehicles?filter[route_type]=0,1,2,3,4` → every active MBTA vehicle.
- Vehicle resource: lat, lon, bearing, `current_status`
  (INCOMING_AT / STOPPED_AT / IN_TRANSIT_TO), `current_stop_sequence`, `direction_id`,
  relationships → route, stop, trip. `updated_at` timestamp.
- Route shapes for the map: `GET /shapes?filter[route]=<id>` → Google **encoded polylines**
  (must be decoded client-side; decoder implemented in `js/polyline.js`).
- `GET /routes?filter[type]=...` gives official colors + names.
- CORS is open (the API is designed for client-side use). Verified assumption; if it ever
  fails, fall back to the Python proxy (§6).
- Alternative feed (not used, good to know): raw GTFS-RT protobufs at
  `https://cdn.mbta.com/realtime/VehiclePositions.pb` (+ JSON variants). No key needed.
  Relevant for a future native/headless Pi player that skips the V3 API.

---

## 2. Core design decisions (and the why — don't relitigate without cause)

1. **Zero-build static web app** (vanilla ES modules + Web Audio API + canvas), served by
   `python -m http.server`. Why: dev machine has Python 3.12 but **no Node**; no build
   step means the Pi can serve it with anything; no framework churn. Everything runs
   client-side in the browser.
2. **Browser connects directly to MBTA** (EventSource with `api_key` query param, key
   stored in localStorage via settings UI, never committed). No backend for v1.
3. **Graceful no-key mode:** without a key, poll `/vehicles?filter[route_type]=...` every
   5 s (fits anonymous limits; it's 1 request/poll). With a key, use SSE. Same downstream
   event interface either way (`reset`/`add`/`update`/`remove`).
4. **Buses are texture, not melody.** MBTA runs 250+ simultaneous buses; per-vehicle notes
   would be noise. Bus *activity density* drives the rhythm section (brush/shaker/ride
   busy-ness). Rail lines get the trainjazz-style per-line melodic voices. This is the
   single biggest deliberate divergence from NYC trainjazz, forced by fleet shape.
5. **Everything quantizes to a shared musical clock** (88 BPM swing, 8-bar modal loop in C:
   Dm9 ×2 | G13 ×2 | Cmaj9 ×2 | Am9 ×2). Raw data-triggered pitches with no harmonic
   frame sound like a fax machine; a chord loop + scale-constrained note pools keep it
   jazz no matter what the feed does. Walking bass + brushed drums provide continuity
   when service is sparse (e.g., 2 AM).
6. **Note trigger = vehicle state change.** A note fires when a vehicle's
   `current_status`/`current_stop_sequence` changes (SSE `update`), quantized to the next
   swung 8th. Pitch = progress along the route (stop_sequence normalized) mapped into the
   current chord's scale, ~2 octaves per voice; `direction_id` inverts the mapping so
   inbound/outbound trains run opposite melodic directions.
7. **Synthesized instruments, no samples, for v1.** FM/subtractive Web Audio voices
   (Rhodes, vibes, muted trumpet, clarinet, celesta, upright bass, horn swell, bell,
   noise-based brushes). Zero assets, zero licensing. Known upgrade path: sample packs or
   SoundFonts later (§7).
8. **Instrument map** (in `js/config.js`): Red=Rhodes EP, Mattapan=celesta,
   Orange=muted trumpet, Blue=clarinet, Green B/C/D/E=vibraphone (different octaves/pans),
   Commuter rail=low horn swells (sparse, event-driven), Ferry=bell (rare, distinctive),
   Buses=rhythm density. Official MBTA colors on the map.
9. **UI mirrors trainjazz's feel:** full-screen dark map, serif titling, click-to-start
   (browser autoplay policy requires a gesture), small legend showing line→instrument
   with a glow when a line plays, status badges, settings drawer (API key, per-mode
   toggles, volume).

## 3. File map (all in this folder)

```
index.html          shell: canvas + overlay UI (start panel, legend, settings)
css/style.css       dark editorial theme, MBTA yellow accent
js/config.js        DONE — routes→instrument/color/octave/pan, chord progression,
                    BPM/swing, map bounds, styleForRoute()
js/polyline.js      Google encoded-polyline decoder (for /shapes)
js/mbta.js          data layer: fetch routes+shapes at boot; SSE stream w/ key,
                    5s polling without; emits {reset,add,update,remove} vehicle events;
                    reconnect w/ backoff; conn-status callbacks
js/music.js         audio engine: AudioContext, master clock/transport (lookahead
                    scheduler ~25ms tick/0.12s horizon), swing quantizer, walking bass,
                    brush drums (density-driven), per-instrument synth voices,
                    triggerVehicleNote(routeId, progress01, directionId), volume/mute
js/map.js           canvas renderer: equirectangular projection w/ cos(lat) correction,
                    route polylines, vehicle dots (lerp toward new positions), pulse
                    animation when a note fires, resize handling
js/main.js          wiring: boot sequence, settings/localStorage, legend build,
                    status badges, hooks mbta events → music + map
README.md           quickstart + Pi notes for humans
```

State: all files written and running. Post-listening revisions (Max's feedback, keep these):
- **Rhythm bed (walking bass + drums) is OFF by default** — Max didn't like the constant
  background music. Toggle in settings re-enables it.
- **All voices got longer natural ring-outs** via `setTargetAtTime` tails (no hard stops —
  original envelopes cut off audibly) and oscillators stop well past the tail.
- **Winds must not sound like piano:** trumpet = slow breathy attack + harmon-mute bandpass
  formant sweep + delayed vibrato + sustain; clarinet = square (odd harmonics) + lowpass +
  sine reinforcement + late vibrato + sustain. Keep percussive vs sustained voices clearly
  distinct — this was explicit listening feedback.
- **Map is Leaflet now** (1.9.4 via unpkg CDN, replacing the hand-rolled canvas):
  Carto `dark_nolabels` raster tiles at 0.55 opacity — faint dark city basemap, roads
  emerge on zoom, deliberately NO text labels (Max: roads yes, road names no). Station
  dots appear at zoom ≥ 12 and station names at zoom ≥ 14 (from `/stops?filter[route_type]=0,1`,
  deduped by name — API returns per-platform records). Vehicles/routes draw on one
  L.canvas renderer; eased marker motion + pulse in a rAF loop. Pinch-zoom free on mobile.
- **Instrument map (Max's picks, 2026-09-07):** Green-E (Lechmere–Heath) = saxophone,
  Green-B (–Boston College) = flute, Green-C (–Cleveland Circle) = french horn,
  Green-D (Fenway–Riverside) = tuba, Blue = violin (clarinet retired). Each Green branch
  is its own legend row. Red = Rhodes, Orange = muted trumpet, Mattapan = celesta stay.

## 4. Engine specifics (implement exactly this unless testing says otherwise)

- **Transport:** `setInterval(25ms)`, schedule all events falling within
  `audioCtx.currentTime + 0.12s`. Track absolute beat number; bar = 4 beats;
  progression index = `floor(beat/4) % 8`. Swing: off-8th at `beat + 0.62`.
- **Walking bass:** quarter notes, octave 2. Per-bar pattern from `bassNotes` in the
  progression (already includes approach tones). Triangle-ish pluck, lowpass ~600 Hz,
  short decay. Slight velocity variation.
- **Drums:** ride = bandpassed noise burst (~4–6 kHz) on swung 8ths, prob-gated by
  bus density (0→sparse quarter-note only, 1→full swung ride + shaker 16ths);
  hat "chick" (short dark noise) on beats 2 & 4 always. Bus density = distinct bus ids
  seen in last 60 s, normalized: `min(1, count/150)`.
- **Melodic note:** `pitch = octaveBase*12 + scale[floor(progress01 * scale.length * 2) % scale.length] (+12 for the upper repetition)`;
  direction_id 1 flips progress (1-progress). Clamp per-voice polyphony (max ~4 concurrent
  per line) and global melodic notes/sec (~8) — drop excess, prefer STOPPED_AT events.
- **CR horns:** only on status transitions to STOPPED_AT or departures; swell 1.5 s,
  root or fifth of current chord, octave 3. Ferry bell: FM bell (carrier+mod ~3.5:1),
  any event, quantized to beat.
- **Voices:** each note = fresh oscillator/gain/filter chain → per-instrument
  StereoPannerNode → master compressor → destination. Rhodes = 2 sines (1 + 2.01×,
  fast attack/med decay + slight FM); vibes = sine + tremolo LFO ~5 Hz, 2 s decay;
  trumpet = sawtooth → bandpass ~1.2 kHz, 60 ms attack; clarinet = odd-harmonic
  (square-ish via triangle + shaping), soft; celesta = sine + 3rd partial, bright fast.

## 5. Testing checklist (localhost phase)

1. `python -m http.server 8000` in this folder → http://localhost:8000
2. No key: status badge shows "polling"; vehicles appear on map within 5 s; sound after
   Start click. Console free of CORS errors (if CORS fails see §6 fallback).
3. Paste key in settings: badge flips to "live stream"; updates become near-instant.
4. Verify: legend glows match audible instruments; bus toggle changes drum density;
   volume/mute work; overnight (few vehicles) still musical (bass+drums carry).
5. Tune to taste: BPM/SWING/progression in config.js are the intended knobs.

## 6. Raspberry Pi roadmap (phase 2 — the real goal)

Two paths, in order of pragmatism:
1. **Kiosk (do first):** Pi OS + auto-started Chromium `--kiosk --autoplay-policy=no-user-gesture-required`
  pointing at localhost:8000 (Pi serves the same static folder). Audio out 3.5 mm/HDMI/USB DAC.
  A Pi 3B+ suffices; Pi Zero 2 W is marginal but worth testing. Needs the autoplay flag
  because there's no click. Systemd units: one for `python -m http.server`, one for kiosk.
2. **Native headless player (the "individual platform" end state):** Python daemon on the
  Pi consuming the same feed — either V3 SSE (`requests`/`httpx` streaming) or the no-key
  GTFS-RT JSON at cdn.mbta.com — reimplementing the §4 engine with a Python synth stack.
  Realistic options: `pyo`, or FluidSynth + a jazz SoundFont driven via MIDI events
  (mido → fluidsynth), which would *upgrade* sound quality over Web Audio synthesis.
  The music *logic* (transport, quantize, mapping) ports 1:1 from music.js; keep it
  cleanly separated there for exactly this reason.
  Note: this machine's homelab (elite-server, see EliteDesk Server Setup project) could
  also host the web version 24/7 in Docker trivially — same static folder + any web server.

## 7. Later ideas (parked, not v1)
- Sampled instruments / SoundFont for realism; per-line volume mixing UI.
- Alerts feed → musical events (delay alert = blue note / minor turnaround).
- Predictions feed for anticipatory phrasing (note *before* arrival).
- Spotlight mode: pick 3–5 key bus routes (1, 28, 39, 66, SL1…) as soft plucked guitar.
- Time-of-day: key/tempo shifts (late night = slower, darker).
- Record/stream output (Icecast) so the Pi could also serve audio to the network.
- Public deploy (would then need the key server-side or a tiny proxy).
