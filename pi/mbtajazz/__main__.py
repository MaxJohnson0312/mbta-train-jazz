"""MBTA Train Jazz — headless audio player.

    python -m mbtajazz                      # play live, default audio device
    python -m mbtajazz --volume 0.5
    python -m mbtajazz --mute Green-D Bus   # silence specific lines
    python -m mbtajazz --render out.wav --seconds 60 --simulate   # no device/network
"""

import argparse
import logging
import os
import signal
import sys
import time

import numpy as np

from . import config as C
from .band import Band
from .feed import VehicleFeed

log = logging.getLogger("mbtajazz")


# --------------------------------------------------------------------------
class Conductor:
    """Turns vehicle events into notes (mirrors handleVehicle in js/main.js)."""

    def __init__(self, band):
        self.band = band
        self.prev = {}          # vehicle id -> (status, stop_sequence)
        self.max_seq = {}       # route id -> highest stop_sequence seen
        self.bus_seen = {}      # bus id -> last seen monotonic time
        self.counts = {}        # mute key -> set of vehicle ids

    def on_reset(self, vehicles):
        self.counts.clear()
        for v in vehicles:
            self.on_vehicle(v)
        log.info("feed reset: %d vehicles", len(vehicles))

    def on_remove(self, vid):
        self.prev.pop(vid, None)
        self.bus_seen.pop(vid, None)
        for s in self.counts.values():
            s.discard(vid)

    def on_vehicle(self, v):
        rid = v["route_id"]
        rtype = C.route_type_of(rid)
        self.counts.setdefault(C.mute_key_of(rid), set()).add(v["id"])

        if rtype == C.BUS:
            self.bus_seen[v["id"]] = time.monotonic()
            return

        seq = v["stop_sequence"]
        if seq is not None:
            self.max_seq[rid] = max(self.max_seq.get(rid, 1), seq)
        progress = min(1.0, (seq or 0) / max(self.max_seq.get(rid, 1), 1))

        key = (v["status"], seq)
        prev = self.prev.get(v["id"])
        self.prev[v["id"]] = key
        if prev is None or prev == key:
            return                       # first sighting, or nothing changed

        arrival = v["status"] == "STOPPED_AT"
        if rtype == C.COMMUTER:
            if arrival:
                self.band.trigger_bass_line(progress)
        elif rtype == C.FERRY:
            self.band.trigger_bell()
        else:
            self.band.trigger_vehicle(rid, progress, v["direction_id"], arrival)

    def refresh_density(self):
        now = time.monotonic()
        self.bus_seen = {k: t for k, t in self.bus_seen.items() if now - t < 60}
        self.band.bus_density = min(1.0, len(self.bus_seen) / 150.0)


# --------------------------------------------------------------------------
def simulate(band, conductor, stop_flag):
    """Fake traffic, for testing with no network."""
    import random
    rng = random.Random(7)
    lines = [r for r in C.RAIL_ROUTES]
    n = 0
    while not stop_flag():
        n += 1
        rid = rng.choice(lines)
        conductor.on_vehicle(dict(id=f"sim{n%40}", route_id=rid,
                                  status="STOPPED_AT" if n % 3 == 0 else "IN_TRANSIT_TO",
                                  stop_sequence=rng.randint(1, 20),
                                  direction_id=rng.randint(0, 1),
                                  lat=0, lon=0))
        for b in range(60):
            conductor.bus_seen[f"bus{b}"] = time.monotonic()
        conductor.refresh_density()
        time.sleep(0.35)


# --------------------------------------------------------------------------
def make_offline_sim(band, conductor, every=0.32):
    """Event source keyed to rendered frames, for --simulate --render."""
    import random
    rng = random.Random(7)
    lines = list(C.RAIL_ROUTES)
    state = dict(next_frame=0, n=0)
    step = int(every * band.sr)

    def on_block(frame):
        if frame < state["next_frame"]:
            return
        state["next_frame"] = frame + step
        state["n"] += 1
        n = state["n"]
        conductor.on_vehicle(dict(id=f"sim{n % 12}", route_id=rng.choice(lines),
                                  status="STOPPED_AT" if n % 3 == 0 else "IN_TRANSIT_TO",
                                  stop_sequence=rng.randint(1, 20),
                                  direction_id=rng.randint(0, 1), lat=0, lon=0))
        if n % 5 == 0:      # a commuter rail arrival and a ferry now and then
            conductor.on_vehicle(dict(id=f"cr{n % 7}", route_id="CR-Worcester",
                                      status="STOPPED_AT", stop_sequence=rng.randint(1, 12),
                                      direction_id=0, lat=0, lon=0))
        if n % 23 == 0:
            conductor.on_vehicle(dict(id="boat1", route_id="Boat-F1",
                                      status="STOPPED_AT", stop_sequence=n % 5,
                                      direction_id=0, lat=0, lon=0))
        band.bus_density = 0.6
    return on_block


def render_wav(band, path, seconds, on_block=None, realtime=False):
    """Render to a WAV file — no audio device needed.

    `on_block(frame)` is called before each block so an offline simulation can
    inject events on the *audio* timeline (offline rendering runs far faster
    than realtime, so wall-clock event sources barely fire).

    `realtime=True` paces rendering to the wall clock, which is what you want
    when recording the *live* feed — otherwise the whole file renders in a
    couple of seconds and captures almost no vehicle activity.
    """
    import wave
    total = int(seconds * band.sr)
    frames = []
    done = 0
    t0 = time.monotonic()
    while done < total:
        n = min(C.BLOCK, total - done)
        if on_block:
            on_block(done)
        frames.append(band.render(n))
        done += n
        if realtime:
            ahead = done / band.sr - (time.monotonic() - t0)
            if ahead > 0:
                time.sleep(min(ahead, 0.25))
    buf = np.concatenate(frames)
    peak = float(np.abs(buf).max())
    pcm = (np.clip(buf, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(band.sr)
        w.writeframes(pcm.tobytes())
    log.info("wrote %s (%.1fs, peak %.3f)", path, seconds, peak)
    return peak


def play_sounddevice(band, device, stop_flag):
    import sounddevice as sd

    def callback(outdata, frames, time_info, status):
        if status:
            log.debug("stream status: %s", status)
        outdata[:] = band.render(frames)

    with sd.OutputStream(samplerate=band.sr, channels=2, dtype="float32",
                         blocksize=C.BLOCK, device=device, callback=callback):
        log.info("playing via sounddevice (device=%s)", device or "default")
        while not stop_flag():
            time.sleep(0.2)


def play_aplay(band, device, stop_flag):
    """Fallback backend: pipe PCM to ALSA's aplay. Always present on Pi OS."""
    import subprocess
    cmd = ["aplay", "-q", "-t", "raw", "-f", "S16_LE", "-c", "2",
           "-r", str(band.sr)]
    if device:
        cmd += ["-D", device]
    log.info("playing via aplay (%s)", " ".join(cmd))
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        while not stop_flag():
            block = band.render(C.BLOCK)
            pcm = (np.clip(block, -1, 1) * 32767).astype("<i2")
            p.stdin.write(pcm.tobytes())
            p.stdin.flush()
    finally:
        try:
            p.stdin.close()
        except Exception:
            pass
        p.terminate()


# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(prog="mbtajazz", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api-key", default=os.environ.get("MBTA_API_KEY", C.DEFAULT_API_KEY),
                    help="MBTA V3 API key (enables the live SSE stream)")
    ap.add_argument("--volume", type=float, default=0.7, help="0..1 (default 0.7)")
    ap.add_argument("--device", default=os.environ.get("MBTA_AUDIO_DEVICE"),
                    help="audio device (sounddevice index/name, or ALSA name for aplay)")
    ap.add_argument("--backend", choices=["auto", "sounddevice", "aplay"], default="auto")
    ap.add_argument("--mute", nargs="*", default=[], metavar="LINE",
                    help=f"lines to silence: {', '.join(C.MUTE_KEYS)}")
    ap.add_argument("--rhythm-bed", action="store_true",
                    help="add the walking bass under the drums")
    ap.add_argument("--no-buses", action="store_true", help="no brushes/shaker")
    ap.add_argument("--simulate", action="store_true", help="fake traffic, no network")
    ap.add_argument("--render", metavar="OUT.WAV", help="render to a file instead of playing")
    ap.add_argument("--seconds", type=float, default=60.0, help="length for --render")
    ap.add_argument("--list-lines", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s",
                        datefmt="%H:%M:%S")

    if args.list_lines:
        for k in C.MUTE_KEYS:
            style = C.RAIL_ROUTES.get(k)
            who = style["who"] if style else \
                {"Silver": "Vibraphone", "CR": "Double bass",
                 "Boat": "Ship's bell", "Bus": "Brushes & shaker"}[k]
            print(f"  {k:<12} {who}")
        return 0

    bad = [m for m in args.mute if m not in C.MUTE_KEYS]
    if bad:
        ap.error(f"unknown line(s): {', '.join(bad)} (see --list-lines)")

    band = Band(volume=max(0.0, min(1.0, args.volume)))
    band.muted = set(args.mute)
    band.enabled["rhythm"] = args.rhythm_bed
    band.enabled["buses"] = not args.no_buses
    conductor = Conductor(band)

    stopping = False

    def stop_flag():
        return stopping

    def handle_signal(signum, _frame):
        nonlocal stopping
        log.info("signal %s — shutting down", signum)
        stopping = True

    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_signal)

    # --- data source ---
    feed = None
    offline_sim = None
    if args.simulate and args.render:
        offline_sim = make_offline_sim(band, conductor)
        log.info("simulating traffic on the audio timeline")
    elif args.simulate:
        import threading
        threading.Thread(target=simulate, args=(band, conductor, stop_flag),
                         daemon=True).start()
        log.info("simulating traffic (no network)")
    else:
        feed = VehicleFeed(args.api_key, conductor.on_reset, conductor.on_vehicle,
                           conductor.on_remove,
                           on_status=lambda k, m: log.info("feed: %s", m))
        feed.start()

        import threading

        def density_loop():
            while not stopping:
                conductor.refresh_density()
                time.sleep(5)
        threading.Thread(target=density_loop, daemon=True).start()

    # --- output ---
    try:
        if args.render:
            # Recording the live feed has to run at realtime; a simulated
            # render can go as fast as the CPU allows.
            render_wav(band, args.render, args.seconds, on_block=offline_sim,
                       realtime=feed is not None)
            return 0

        backend = args.backend
        if backend == "auto":
            try:
                import sounddevice  # noqa: F401
                backend = "sounddevice"
            except Exception:
                backend = "aplay"
        if backend == "sounddevice":
            play_sounddevice(band, args.device, stop_flag)
        else:
            play_aplay(band, args.device, stop_flag)
    finally:
        stopping = True
        if feed:
            feed.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
