# MBTA Train Jazz

Live MBTA vehicles — subway, commuter rail, ferries, buses — become an ambient jazz
combo over a live map. Inspired by [trainjazz.com](https://www.trainjazz.com/) (NYC).

Every rapid-transit line is an instrument (Red = electric piano, Orange = muted trumpet,
Blue = clarinet, Green = vibraphone, Mattapan = celesta). A note plays when a train
moves or arrives, pitched by how far along its route it is. Commuter rail arrivals are
low horn swells, ferries are a ship's bell, and the ~hundreds of live buses drive how
busy the brushed drums and shaker are. Everything locks to an 88 BPM swing over an
8-bar modal loop, so it stays musical at 2 AM with three trains or at rush hour with
four hundred vehicles.

## Run it

No build step. From this folder:

```
python -m http.server 8000
```

Open http://localhost:8000 and click **Start the band**.

- **Without an API key** it polls the MBTA every 5 s. Fine for trying it out.
- **With a free key** ([get one here](https://api-v3.mbta.com)) — paste it into ⚙
  Settings — it switches to the MBTA's server-sent-event stream: instant updates over
  one connection. The key is stored in your browser's localStorage only.

## Tuning

The musical knobs live in `js/config.js`: tempo (`BPM`), swing feel (`SWING`), the chord
loop (`PROGRESSION`), and each line's instrument/octave/stereo position (`RAIL_ROUTES`).
Synth voicings are in `js/music.js`.

## Roadmap

See `PLAN.md` for the full architecture, research notes, and the Raspberry Pi
speaker-appliance plan (Chromium kiosk first, native Python/FluidSynth player later).

## Credits

- Live data: [MBTA V3 API](https://www.mbta.com/developers/v3-api)
- Instruments: FluidR3_GM samples via [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), self-hosted in `samples/`
- Basemap: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © [CARTO](https://carto.com/attributions)
- Inspired by [trainjazz.com](https://www.trainjazz.com/)
