"""Routes, instruments and musical tuning.

This mirrors the web app's js/config.js. If you change the music there, change
it here too (and vice versa) — the two are intentionally kept in sync so the Pi
sounds like the website.
"""

API_BASE = "https://api-v3.mbta.com"

# Free MBTA key (same one the website uses). Override with --api-key or the
# MBTA_API_KEY environment variable.
DEFAULT_API_KEY = "fbfb915838234e6d88bd6256ac2b1de8"

SAMPLE_RATE = 44100
BLOCK = 1024                    # frames per render block

# --- Musical tuning -------------------------------------------------------
BPM = 88
SWING = 0.62                    # where the off-eighth sits inside the beat
BEATS_PER_BAR = 4

# 8-bar modal loop in C: bass tones per beat, and a scale for melodic voices.
PROGRESSION = [
    dict(name="Dm9",   root=2, bass=[2, 5, 9, 0],  scale=[2, 5, 7, 9, 12, 14]),
    dict(name="Dm9",   root=2, bass=[2, 9, 5, 4],  scale=[2, 5, 7, 9, 12, 14]),
    dict(name="G13",   root=7, bass=[7, 11, 2, 5], scale=[7, 9, 11, 14, 16, 17]),
    dict(name="G13",   root=7, bass=[7, 2, 11, 8], scale=[7, 9, 11, 14, 16, 17]),
    dict(name="Cmaj9", root=0, bass=[0, 4, 7, 9],  scale=[0, 4, 7, 9, 11, 14]),
    dict(name="Cmaj9", root=0, bass=[0, 7, 4, 10], scale=[0, 4, 7, 9, 11, 14]),
    dict(name="Am9",   root=9, bass=[9, 0, 4, 7],  scale=[9, 12, 14, 16, 19, 21]),
    dict(name="Am9",   root=9, bass=[9, 4, 0, 3],  scale=[9, 12, 14, 16, 19, 21]),
]

# --- Voices ---------------------------------------------------------------
# route id -> instrument, register and stereo position
RAIL_ROUTES = {
    "Red":      dict(instrument="rhodes",     label="Red Line",     who="Electric piano", octave=4, pan=-0.30),
    "Mattapan": dict(instrument="guitar",     label="Mattapan",     who="Jazz guitar",    octave=4, pan=-0.50),
    "Orange":   dict(instrument="trumpet",    label="Orange Line",  who="Muted trumpet",  octave=4, pan=+0.30),
    "Blue":     dict(instrument="violin",     label="Blue Line",    who="Violin",         octave=5, pan=+0.50),
    "Green-B":  dict(instrument="flute",      label="Green Line B", who="Flute",          octave=5, pan=-0.20),
    "Green-C":  dict(instrument="frenchhorn", label="Green Line C", who="French horn",    octave=3, pan=+0.20),
    "Green-D":  dict(instrument="tuba",       label="Green Line D", who="Tuba",           octave=2, pan=+0.60),
    "Green-E":  dict(instrument="sax",        label="Green Line E", who="Saxophone",      octave=4, pan=-0.60),
    # Silver Line is a "bus" in GTFS but plays as rapid transit here.
    "741":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=5, pan=-0.40),
    "742":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=5, pan=-0.15),
    "743":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=5, pan=+0.10),
    "746":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=4, pan=+0.35),
    "749":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=4, pan=-0.25),
    "751":      dict(instrument="vibes", label="Silver Line", who="Vibraphone", octave=4, pan=+0.50),
}

SILVER_LINE = ["741", "742", "743", "746", "749", "751"]

# GTFS route_type
LIGHT_RAIL, HEAVY_RAIL, COMMUTER, BUS, FERRY = 0, 1, 2, 3, 4


def route_type_of(route_id: str) -> int:
    """Classify a route the same way the web app does."""
    if not route_id:
        return BUS
    if route_id.startswith("CR-"):
        return COMMUTER
    if route_id.startswith("Boat-"):
        return FERRY
    if route_id in ("Red", "Orange", "Blue"):
        return HEAVY_RAIL
    if route_id == "Mattapan" or route_id.startswith("Green-"):
        return LIGHT_RAIL
    if route_id in SILVER_LINE:
        return LIGHT_RAIL
    return BUS


def mute_key_of(route_id: str) -> str:
    """The name used by --mute (one key per 'line', Silver Line grouped)."""
    if not route_id:
        return "Bus"
    if route_id in SILVER_LINE:
        return "Silver"
    if route_id.startswith("CR-"):
        return "CR"
    if route_id.startswith("Boat-"):
        return "Boat"
    return route_id if route_id in RAIL_ROUTES else "Bus"


# Every mutable "line" name, for --mute validation and --list-lines.
MUTE_KEYS = [r for r in RAIL_ROUTES if r not in SILVER_LINE] + ["Silver", "CR", "Boat", "Bus"]
