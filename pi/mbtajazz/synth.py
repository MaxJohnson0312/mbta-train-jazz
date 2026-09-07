"""Voice rendering.

Every note is rendered to a finished stereo float32 array *before* it reaches
the audio callback, so the realtime path only ever does additions. These are
numpy ports of the Web Audio voices in js/music.js — same oscillator ratios,
envelopes and filters, so the Pi sounds like the website.
"""

import numpy as np
from scipy.signal import butter, lfilter

A4 = 440.0


def midi_hz(m: float) -> float:
    return A4 * 2.0 ** ((m - 69) / 12.0)


def pitch_midi(semitone_from_c: int, octave: int) -> int:
    """Our (semitone, octave) pair -> MIDI number. C4 = 60."""
    return 12 * (octave + 1) + semitone_from_c


def pitch_hz(semitone_from_c: int, octave: int) -> float:
    return midi_hz(pitch_midi(semitone_from_c, octave))


# --- primitives -----------------------------------------------------------

def _t(n: int, sr: int) -> np.ndarray:
    return np.arange(n, dtype=np.float64) / sr


def _phase(freq, n: int, sr: int) -> np.ndarray:
    """Phase ramp. `freq` may be a scalar or a per-sample array (for vibrato)."""
    if np.isscalar(freq):
        return 2 * np.pi * freq * _t(n, sr)
    return 2 * np.pi * np.cumsum(np.asarray(freq, dtype=np.float64)) / sr


def osc(shape: str, freq, n: int, sr: int) -> np.ndarray:
    ph = _phase(freq, n, sr)
    if shape == "sine":
        return np.sin(ph)
    if shape == "square":
        return np.sign(np.sin(ph))
    frac = np.mod(ph / (2 * np.pi), 1.0)          # 0..1 ramp
    if shape == "saw":
        return 2.0 * frac - 1.0
    if shape == "triangle":
        return 2.0 * np.abs(2.0 * frac - 1.0) - 1.0
    raise ValueError(shape)


def noise(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1.0, 1.0, n)


def vibrato(base_hz: float, n: int, sr: int, rate: float, depth_hz: float,
            delay: float) -> np.ndarray:
    """Per-sample frequency array: vibrato fades in after `delay` seconds."""
    t = _t(n, sr)
    ramp = np.clip((t - delay) / 0.25, 0.0, 1.0)
    return base_hz + depth_hz * ramp * np.sin(2 * np.pi * rate * t)


def strike_env(n: int, sr: int, peak: float, ring: float) -> np.ndarray:
    """Percussive: fast attack, then a natural exponential tail (no hard stop)."""
    t = _t(n, sr)
    atk = 0.005
    env = np.exp(-np.maximum(t - atk, 0.0) / (ring / 5.0))
    env = np.where(t < atk, t / atk, env)
    return peak * env


def wind_env(n: int, sr: int, peak: float, attack: float, hold: float,
             release: float) -> np.ndarray:
    """Sustained: slow attack, held body, gentle release."""
    t = _t(n, sr)
    env = np.ones(n)
    a = t < attack
    env[a] = t[a] / max(attack, 1e-6)
    r = t >= attack + hold
    env[r] = np.exp(-(t[r] - attack - hold) / (release / 3.0))
    return peak * env


def _filt(kind: str, cutoff, sig: np.ndarray, sr: int, order: int = 2,
          q: float = 0.707) -> np.ndarray:
    nyq = sr / 2.0
    if kind == "bandpass":
        bw = max(cutoff / max(q, 0.1), 20.0)
        lo = max(cutoff - bw / 2, 20.0) / nyq
        hi = min(cutoff + bw / 2, nyq - 100) / nyq
        if hi <= lo:
            return sig
        b, a = butter(order, [lo, hi], btype="band")
    else:
        wn = min(max(cutoff / nyq, 1e-4), 0.99)
        b, a = butter(order, wn, btype=kind)
    return lfilter(b, a, sig)


def _sweep_filter(sig: np.ndarray, sr: int, f0: float, f1: float,
                  q: float) -> np.ndarray:
    """Cheap swept bandpass: crossfade between the two endpoint filters."""
    a = _filt("bandpass", f0, sig, sr, q=q)
    b = _filt("bandpass", f1, sig, sr, q=q)
    x = np.linspace(0.0, 1.0, len(sig))
    return a * (1 - x) + b * x


def stereo(mono: np.ndarray, pan: float) -> np.ndarray:
    """Equal-power pan into an (N,2) float32 buffer."""
    p = (np.clip(pan, -1.0, 1.0) + 1.0) * 0.25 * np.pi   # 0..pi/2
    out = np.empty((len(mono), 2), dtype=np.float32)
    out[:, 0] = mono * np.cos(p)
    out[:, 1] = mono * np.sin(p)
    return out


# --- melodic voices -------------------------------------------------------
# Each returns a mono array; the caller pans it.

def v_rhodes(hz, vel, sr, rng):
    n = int(3.2 * sr)
    out = np.zeros(n)
    for ratio, amp, ring in ((1, 1, 1.6), (2.01, 0.22, 0.6), (5.04, 0.05, 0.15)):
        out += osc("sine", hz * ratio, n, sr) * strike_env(n, sr, vel * 0.27 * amp, ring)
    return out


def v_guitar(hz, vel, sr, rng):
    """Jazz guitar: plucked triangle harmonics + a pick transient."""
    n = int(3.0 * sr)
    out = np.zeros(n)
    for ratio, amp, ring in ((1, 1, 1.5), (2, 0.35, 0.7), (3, 0.14, 0.35), (4, 0.06, 0.2)):
        out += osc("triangle", hz * ratio, n, sr) * strike_env(n, sr, vel * 0.25 * amp, ring)
    pn = int(0.05 * sr)
    pick = _filt("bandpass", min(3000, hz * 6), noise(pn, rng), sr, q=1.5)
    out[:pn] += pick * strike_env(pn, sr, vel * 0.05, 0.03)
    return out


def v_trumpet(hz, vel, sr, rng):
    """Harmon-muted trumpet: breathy attack, formant sweep, late vibrato."""
    n = int(2.5 * sr)
    f = vibrato(hz, n, sr, 5.5, hz * 0.012, 0.25)
    body = _sweep_filter(osc("saw", f, n, sr), sr, min(900, hz * 2), min(1600, hz * 3.5), q=7)
    out = body * wind_env(n, sr, vel * 0.72, 0.09, 0.55, 0.5)
    bn = int(0.25 * sr)
    out[:bn] += _filt("bandpass", 2500, noise(bn, rng), sr, q=1) * \
        wind_env(bn, sr, vel * 0.03, 0.05, 0.05, 0.15)
    return out


def v_sax(hz, vel, sr, rng):
    """Reedy saw+square through a vocal-ish formant, with breath."""
    n = int(2.4 * sr)
    f = vibrato(hz, n, sr, 5.2, hz * 0.010, 0.28)
    reed = osc("saw", f, n, sr) + 0.25 * osc("square", hz * 1.003, n, sr)
    body = _filt("bandpass", min(1800, hz * 2.6), reed, sr, q=1.4)
    out = body * wind_env(n, sr, vel * 0.28, 0.07, 0.5, 0.4)
    bn = int(0.2 * sr)
    out[:bn] += _filt("bandpass", 1900, noise(bn, rng), sr, q=1) * \
        wind_env(bn, sr, vel * 0.035, 0.05, 0.08, 0.1)
    return out


def v_flute(hz, vel, sr, rng):
    """Nearly pure tone with continuous airiness."""
    n = int(2.4 * sr)
    f = vibrato(hz, n, sr, 5.4, hz * 0.008, 0.25)
    env = wind_env(n, sr, vel * 0.30, 0.06, 0.55, 0.4)
    out = osc("sine", f, n, sr) * env
    out += osc("triangle", hz, n, sr) * wind_env(n, sr, vel * 0.06, 0.06, 0.55, 0.4)
    out += _filt("bandpass", 3200, noise(n, rng), sr, q=1) * \
        wind_env(n, sr, vel * 0.045, 0.06, 0.5, 0.4)
    return out


def v_frenchhorn(hz, vel, sr, rng):
    """Dark, round, noble: detuned saws under a heavy lowpass, plus a sub."""
    n = int(2.8 * sr)
    out = np.zeros(n)
    for ratio, amp in ((1, 1), (1.004, 0.7)):
        sig = _filt("low", min(750, hz * 2.2), osc("saw", hz * ratio, n, sr), sr)
        out += sig * wind_env(n, sr, vel * 0.30 * amp, 0.13, 0.6, 0.55)
    out += osc("sine", hz / 2, n, sr) * wind_env(n, sr, vel * 0.10, 0.13, 0.6, 0.55)
    return out


def v_tuba(hz, vel, sr, rng):
    """Fat, bouncy low brass with a short brassy blat on the attack."""
    n = int(1.8 * sr)
    body = _filt("low", 320, osc("triangle", hz, n, sr), sr)
    out = body * wind_env(n, sr, vel * 0.26, 0.05, 0.25, 0.3)
    out += osc("sine", hz, n, sr) * wind_env(n, sr, vel * 0.16, 0.05, 0.25, 0.3)
    bn = int(0.4 * sr)
    out[:bn] += _filt("low", 600, osc("saw", hz, bn, sr), sr) * \
        strike_env(bn, sr, vel * 0.12, 0.1)
    return out


def v_violin(hz, vel, sr, rng):
    """Bowed: slow attack, singing sustain, prominent vibrato."""
    n = int(3.0 * sr)
    out = np.zeros(n)
    for ratio, amp in ((1, 1), (1.006, 0.55)):
        f = vibrato(hz * ratio, n, sr, 5.6, hz * 0.013, 0.2)
        sig = _filt("low", min(3800, hz * 5), osc("saw", f, n, sr), sr)
        sig = _filt("high", 250, sig, sr)
        out += sig * wind_env(n, sr, vel * 0.24 * amp, 0.16, 0.7, 0.5)
    return out


def v_vibes(hz, vel, sr, rng):
    """Vibraphone: pure tone, motor tremolo, long shimmer."""
    n = int(4.5 * sr)
    trem = 1.0 + 0.35 * np.sin(2 * np.pi * 3.8 * _t(n, sr))
    out = osc("sine", hz, n, sr) * strike_env(n, sr, vel * 0.24, 2.8) * trem
    out += osc("sine", hz * 3.99, n, sr) * strike_env(n, sr, vel * 0.06, 0.5)
    return out


def v_celesta(hz, vel, sr, rng):
    n = int(2.8 * sr)
    out = osc("sine", hz, n, sr) * strike_env(n, sr, vel * 0.22, 1.4)
    out += osc("sine", hz * 2.98, n, sr) * strike_env(n, sr, vel * 0.09, 0.4)
    return out


def v_contrabass(hz, vel, sr, rng):
    """Pizzicato double bass: deep and woody."""
    n = int(2.4 * sr)
    out = np.zeros(n)
    for ratio, amp, ring in ((1, 1, 1.1), (2, 0.3, 0.4), (3, 0.1, 0.2)):
        sig = _filt("low", 420, osc("triangle", hz * ratio, n, sr), sr)
        out += sig * strike_env(n, sr, vel * 0.5 * amp, ring)
    return out


def v_bell(hz, vel, sr, rng):
    """Ship's bell: FM with a long fade."""
    n = int(4.5 * sr)
    t = _t(n, sr)
    idx = hz * 2 * np.exp(-t / 0.8)                 # modulation index decays
    mod = idx * np.sin(2 * np.pi * hz * 3.5 * t)
    car = np.sin(2 * np.pi * hz * t + np.cumsum(mod) * 2 * np.pi / sr)
    return car * strike_env(n, sr, vel * 0.4, 2.6)


def v_bass(hz, vel, sr, rng):
    """Walking bass (rhythm bed)."""
    n = int(1.2 * sr)
    sig = _filt("low", 500, osc("triangle", hz, n, sr), sr)
    return sig * strike_env(n, sr, vel * 0.4, 0.5)


MELODIC = {
    "rhodes": v_rhodes, "guitar": v_guitar, "trumpet": v_trumpet, "sax": v_sax,
    "flute": v_flute, "frenchhorn": v_frenchhorn, "tuba": v_tuba,
    "violin": v_violin, "vibes": v_vibes, "celesta": v_celesta,
}


# --- percussion -----------------------------------------------------------

def _burst(sr, rng, vel, kind, freq, q, decay):
    n = int((decay + 0.1) * sr)
    sig = _filt(kind, freq, noise(n, rng), sr, q=q)
    return sig * strike_env(n, sr, vel, decay)


def p_ride(vel, sr, rng):
    return _burst(sr, rng, vel * 0.12, "bandpass", 5200, 1.2, 0.35)


def p_hat(vel, sr, rng):
    return _burst(sr, rng, vel * 0.10, "high", 7000, 1.0, 0.06)


def p_shaker(vel, sr, rng):
    return _burst(sr, rng, vel * 0.50, "bandpass", 6800, 2.5, 0.05)


def p_sweep(vel, sr, rng, dur):
    """Brush sweep: soft noise swelling and falling across most of a beat."""
    n = int((dur + 0.1) * sr)
    sig = _sweep_filter(noise(n, rng), sr, 1800, 3600, q=0.8)
    t = _t(n, sr)
    up = np.clip(t / (dur * 0.45), 0, 1)
    down = np.clip((dur - t) / (dur * 0.55), 0, 1)
    return sig * vel * up * down
