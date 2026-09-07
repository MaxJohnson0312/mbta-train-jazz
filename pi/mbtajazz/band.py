"""The band: a sample-accurate transport, a mixer, and the note-trigger logic.

The audio stream's own frame counter is the master clock, so there is no drift.
Notes are rendered to finished buffers on the calling thread and handed to the
mixer, which only adds them into the output block.
"""

import threading
import numpy as np

from . import config as C
from . import synth as S


class Band:
    def __init__(self, sr=C.SAMPLE_RATE, volume=0.7, seed=None):
        self.sr = sr
        self.volume = volume
        self.rng = np.random.default_rng(seed)

        self.sec_per_beat = 60.0 / C.BPM
        self.frames_per_beat = self.sec_per_beat * sr

        self.frame = 0                  # frames rendered so far (the clock)
        self.beat = 0                   # next beat index to schedule
        self._active = []               # [start_frame, buf(N,2), pos]
        self._lock = threading.Lock()

        self.bus_density = 0.0          # 0..1, set from the feed
        self.enabled = dict(cr=True, ferry=True, buses=True, rhythm=False)
        self.muted = set()              # mute keys (see config.mute_key_of)

        self._recent = []               # frame stamps, for the note-rate cap
        self._active_per_route = {}
        self.on_note = None             # callback(route_id) for logging

    # --- clock helpers ----------------------------------------------------
    def _beat_frame(self, b):
        return int(round(b * self.frames_per_beat))

    def _chord_at(self, b):
        return C.PROGRESSION[(b // C.BEATS_PER_BAR) % len(C.PROGRESSION)]

    def _next_grid_frame(self):
        """Next swung eighth at or after now, plus a small safety margin."""
        now = self.frame + int(0.05 * self.sr)
        b = now / self.frames_per_beat
        i, frac = int(b // 1), b % 1.0
        target = i + C.SWING if frac < C.SWING else i + 1
        return self._beat_frame(target), int(target)

    # --- mixing -----------------------------------------------------------
    def _schedule(self, start_frame, buf):
        if buf is None or len(buf) == 0:
            return
        with self._lock:
            self._active.append([max(start_frame, self.frame), buf, 0])

    def render(self, n):
        """Render the next n frames. Called by the audio backend."""
        self._schedule_beats(n)
        out = np.zeros((n, 2), dtype=np.float32)
        block_start, block_end = self.frame, self.frame + n

        with self._lock:
            still = []
            for item in self._active:
                start, buf, pos = item
                if start >= block_end:
                    still.append(item)
                    continue
                off = max(0, start - block_start)          # offset into out
                take = min(n - off, len(buf) - pos)
                if take > 0:
                    out[off:off + take] += buf[pos:pos + take]
                    item[2] = pos + take
                    item[0] = block_start + off + take
                if item[2] < len(buf):
                    still.append(item)
            self._active = still

        self.frame = block_end
        out *= self.volume
        np.clip(out, -1.0, 1.0, out=out)                    # brickwall safety
        return out

    # --- the rhythm section ----------------------------------------------
    def _schedule_beats(self, n):
        """Schedule any beats landing inside the block we're about to render."""
        horizon = self.frame + n + int(0.2 * self.sr)
        while self._beat_frame(self.beat) < horizon:
            self._emit_beat(self.beat)
            self.beat += 1

    def _emit_beat(self, b):
        f0 = self._beat_frame(b)
        chord = self._chord_at(b)
        in_bar = b % C.BEATS_PER_BAR

        if self.enabled["rhythm"] and "Bass" not in self.muted:
            hz = S.pitch_hz(chord["bass"][in_bar], 2)
            vel = 0.9 - self.rng.random() * 0.15
            self._schedule(f0, S.stereo(S.v_bass(hz, vel, self.sr, self.rng), 0.0))

        if not self.enabled["buses"] and not self.enabled["rhythm"]:
            return
        density = self.bus_density if self.enabled["buses"] else 0.35

        # Humanize: a drummer is never on the grid and never at one volume.
        def hum():
            return int(self.rng.uniform(-0.007, 0.007) * self.sr)

        def vel(base, spread):
            return base * (1 - spread + self.rng.random() * spread * 2)

        swung = f0 + int(C.SWING * self.frames_per_beat)
        backbeat = in_bar in (1, 3)

        self._sched_perc(f0 + hum(), S.p_ride(vel(0.42 + density * 0.22, 0.28), self.sr, self.rng))
        if backbeat:
            if self.rng.random() < 0.88:
                self._sched_perc(swung + hum(), S.p_ride(vel(0.30 + density * 0.26, 0.30), self.sr, self.rng))
        elif density > 0.3 and self.rng.random() < density * 0.55:
            self._sched_perc(swung + hum(), S.p_ride(vel(0.20 + density * 0.18, 0.35), self.sr, self.rng))

        if backbeat:
            self._sched_perc(f0 + hum(), S.p_hat(vel(0.5, 0.22), self.sr, self.rng))

        if density > 0.35:
            if self.rng.random() < 0.85:
                self._sched_perc(f0 + hum(), S.p_shaker(vel(0.18, 0.45), self.sr, self.rng))
            if self.rng.random() < density:
                self._sched_perc(swung + hum(), S.p_shaker(vel(0.12, 0.50), self.sr, self.rng))

        if in_bar == 0 and self.rng.random() < 0.30:
            dur = self.sec_per_beat * 0.8
            self._sched_perc(f0 + hum(), S.p_sweep(0.09 + density * 0.09, self.sr, self.rng, dur))

    def _sched_perc(self, frame, mono):
        self._schedule(max(0, frame), S.stereo(mono, 0.0))

    # --- triggers from live data -----------------------------------------
    def trigger_vehicle(self, route_id, progress, direction_id, is_arrival):
        style = C.RAIL_ROUTES.get(route_id)
        if style is None or C.mute_key_of(route_id) in self.muted:
            return

        # global rate cap (~8 notes/sec), preferring arrivals when it's busy
        cutoff = self.frame - self.sr
        self._recent = [f for f in self._recent if f > cutoff]
        if len(self._recent) >= 8 and not is_arrival:
            return
        if self._active_per_route.get(route_id, 0) >= 4:
            return
        self._recent.append(self.frame)

        frame, beat = self._next_grid_frame()
        chord = self._chord_at(max(0, beat))
        p = 1.0 - progress if direction_id == 1 else progress
        scale = chord["scale"]
        steps = len(scale) * 2
        i = int(min(max(p, 0.0), 0.999) * steps)
        semis = scale[i % len(scale)] + (12 if i >= len(scale) else 0)

        fn = S.MELODIC.get(style["instrument"])
        if fn is None:
            return
        hz = S.pitch_hz(semis, style["octave"])
        vel = 0.8 if is_arrival else 0.55
        self._schedule(frame, S.stereo(fn(hz, vel, self.sr, self.rng), style["pan"]))

        self._active_per_route[route_id] = self._active_per_route.get(route_id, 0) + 1
        threading.Timer(2.0, self._release, args=(route_id,)).start()
        if self.on_note:
            self.on_note(route_id)

    def _release(self, route_id):
        self._active_per_route[route_id] = max(0, self._active_per_route.get(route_id, 1) - 1)

    def trigger_bass_line(self, progress):
        """Commuter rail: one deep pizzicato note from the chord's bass tones."""
        if not self.enabled["cr"] or "CR" in self.muted:
            return
        frame, beat = self._next_grid_frame()
        chord = self._chord_at(max(0, beat))
        notes = chord["bass"]
        semis = notes[min(len(notes) - 1, int(progress * len(notes)))]
        hz = S.pitch_hz(semis, 2)
        self._schedule(frame, S.stereo(S.v_contrabass(hz, 0.75, self.sr, self.rng), -0.15))
        if self.on_note:
            self.on_note("CR")

    def trigger_bell(self):
        if not self.enabled["ferry"] or "Boat" in self.muted:
            return
        frame, _ = self._next_grid_frame()
        hz = S.pitch_hz(7, 5)
        self._schedule(frame, S.stereo(S.v_bell(hz, 0.5, self.sr, self.rng), 0.4))
        if self.on_note:
            self.on_note("Boat")
