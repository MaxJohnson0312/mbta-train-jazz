"""Download exactly the FluidR3_GM notes MBTA Train Jazz can play, into samples/."""
import os, sys, urllib.request, concurrent.futures

BASE = "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM"
OUT = sys.argv[1]

NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
def midi_to_name(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"   # C4 = 60

# --- mirror of js/config.js PROGRESSION ---
SCALES = [
    [2, 5, 7, 9, 12, 14],      # Dm9
    [7, 9, 11, 14, 16, 17],    # G13
    [0, 4, 7, 9, 11, 14],      # Cmaj9
    [9, 12, 14, 16, 19, 21],   # Am9
]
ROOTS = [2, 7, 0, 9]
BASS = [[2,5,9,0],[2,9,5,4],[7,11,2,5],[7,2,11,8],[0,4,7,9],[0,7,4,10],[9,0,4,7],[9,4,0,3]]

# melodic voices produce scale tones and the same tones an octave up
melodic_offsets = sorted({s for sc in SCALES for s in sc} | {s + 12 for sc in SCALES for s in sc})

# instrument -> (soundfont name, base octave, offsets)
VOICES = {
    "rhodes":     ("electric_piano_1", 4, melodic_offsets),
    "guitar":     ("electric_guitar_jazz", 4, melodic_offsets),   # Mattapan
    "trumpet":    ("muted_trumpet",    4, melodic_offsets),
    "violin":     ("violin",           5, melodic_offsets),
    "flute":      ("flute",            5, melodic_offsets),
    "frenchhorn": ("french_horn",      3, melodic_offsets),
    "tuba":       ("tuba",             2, melodic_offsets),
    "sax":        ("alto_sax",         4, melodic_offsets),
    # commuter rail: a walking double-bass line
    "contrabass": ("contrabass",       2, sorted({n for bar in BASS for n in bar})),
    # ferry bell: single pitch today, grab a few for future variety
    "bell":       ("tubular_bells",    5, [0, 4, 7, 11]),
    # walking bass
    "bass":       ("acoustic_bass",    2, sorted({n for bar in BASS for n in bar})),
}

jobs = []
for voice, (sf, octave, offsets) in VOICES.items():
    for off in offsets:
        midi = 12 * (octave + 1) + off
        if not 21 <= midi <= 108:      # outside sampled range; runtime pitch-shifts instead
            continue
        name = midi_to_name(midi)
        jobs.append((voice, sf, name))

def grab(job):
    voice, sf, name = job
    d = os.path.join(OUT, voice)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return ("cached", voice, name, os.path.getsize(path))
    try:
        with urllib.request.urlopen(f"{BASE}/{sf}-mp3/{name}.mp3", timeout=30) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
        return ("ok", voice, name, len(data))
    except Exception as e:
        return ("FAIL", voice, name, str(e))

total = 0
fails = []
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
    for status, voice, name, info in ex.map(grab, jobs):
        if status == "FAIL":
            fails.append(f"{voice}/{name}: {info}")
        else:
            total += info

print(f"{len(jobs)} notes requested, {len(fails)} failed, {total/1e6:.2f} MB total")
for f in fails[:20]:
    print("  FAIL", f)
