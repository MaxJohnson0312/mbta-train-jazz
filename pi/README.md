# MBTA Train Jazz — Raspberry Pi player

Audio only. No browser, no display, no visualization. It opens the MBTA's live
vehicle stream, turns it into the same jazz combo as the website, and plays it
out of the Pi's speaker forever.

## Install

On the Pi, with the speaker plugged in:

```bash
git clone https://github.com/MaxJohnson0312/mbta-train-jazz.git
cd mbta-train-jazz/pi
./install.sh
sudo systemctl start mbta-jazz
```

That installs to `/opt/mbta-jazz`, sets up a service that starts on boot and
restarts on failure, and runs an offline smoke test on the way through.

```bash
journalctl -u mbta-jazz -f      # watch it
sudo systemctl stop mbta-jazz   # stop it
```

## Run it by hand

```bash
python -m mbtajazz                          # play
python -m mbtajazz --volume 0.5
python -m mbtajazz --mute Green-D Bus       # silence lines (see --list-lines)
python -m mbtajazz --rhythm-bed             # add the walking bass
python -m mbtajazz --no-buses               # no brushes/shaker
python -m mbtajazz --device hw:1,0          # pick an output
```

Testing without a speaker or without a network:

```bash
python -m mbtajazz --simulate --render demo.wav --seconds 60   # neither needed
python -m mbtajazz --simulate                                  # fake traffic, real audio
```

## Who plays what

| Line | Instrument |
|---|---|
| Red | Electric piano |
| Mattapan | Jazz guitar |
| Orange | Muted trumpet |
| Blue | Violin |
| Green B / C / D / E | Flute / French horn / Tuba / Saxophone |
| Silver Line | Vibraphone |
| Commuter Rail | Pizzicato double bass |
| Ferries | Ship's bell |
| Buses | Brushes & shaker (busier = more buses running) |

A note fires when a vehicle changes state, pitched by how far along its route it
is, quantized to a swung 88 BPM over an 8-bar modal loop. Buses aren't individual
notes — there are hundreds at once — so their count drives the percussion.

## Audio troubleshooting

The single most common problem is the Pi sending audio to the wrong output.

```bash
aplay -l                  # list playback devices
speaker-test -t sine -c2  # confirm the speaker works at all
alsamixer                 # raise volume, press M to unmute
sudo raspi-config         # System Options > Audio > pick headphones or HDMI
```

Then pass the device explicitly, e.g. `--device hw:1,0`, or set
`MBTA_AUDIO_DEVICE` in the service file.

Two backends are supported: `sounddevice` (PortAudio) if it imports, otherwise
piping to ALSA's `aplay`, which is always present on Pi OS. Force one with
`--backend aplay`.

## Performance

Rendering is ~6× faster than realtime on a desktop; a **Pi 4 or Pi 5 has
comfortable headroom**, and a Pi 3B+ should be fine. On a Pi Zero 2 W, if you
hear stutters, try `--no-buses` (percussion is the busiest voice) or raise
`BLOCK` in `mbtajazz/config.py` to 2048.

## How it relates to the website

`mbtajazz/config.py` and `mbtajazz/synth.py` are deliberate ports of the web
app's `js/config.js` and `js/music.js` — same oscillators, envelopes, tuning and
route mapping, so the Pi sounds like the site. Change one, change the other.
