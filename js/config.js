// Central configuration: which routes exist, how they look, and how they sound.

export const API_BASE = "https://api-v3.mbta.com";

// Site's default MBTA API key (free tier, registered for mbta.max-johnson.com).
// Deliberately public: it only unlocks the SSE stream for visitors. Visitors can
// override it in Settings (stored in localStorage). Revocable at api-v3.mbta.com.
export const DEFAULT_API_KEY = "fbfb915838234e6d88bd6256ac2b1de8";

// CARTO basemap key — used for usage tracking on the tile CDN (the tiles are
// public either way). Note: it does NOT waive attribution; the basemap data is
// OpenStreetMap under ODbL, which requires credit on every CARTO plan.
export const CARTO_KEY = "cb1_30lc_1_3a1292f7a07fd372249c8199";

// Melodic voices — one per rail line, mirroring trainjazz.com's
// "one instrument per line" idea. Buses are handled separately as
// an aggregate rhythm section (250+ individual bus notes = noise).
export const RAIL_ROUTES = {
  "Red":      { color: "#DA291C", instrument: "rhodes",     label: "Red Line",     who: "Electric piano", octave: 4, pan: -0.3 },
  "Mattapan": { color: "#DA291C", instrument: "guitar",     label: "Mattapan",     who: "Jazz guitar",    octave: 4, pan: -0.5 },
  "Orange":   { color: "#ED8B00", instrument: "trumpet",    label: "Orange Line",  who: "Muted trumpet",  octave: 4, pan: 0.3 },
  "Blue":     { color: "#003DA5", instrument: "violin",     label: "Blue Line",    who: "Violin",         octave: 5, pan: 0.5 },
  "Green-B":  { color: "#00843D", instrument: "flute",      label: "Green Line B", who: "Flute",          octave: 5, pan: -0.2 },
  "Green-C":  { color: "#00843D", instrument: "frenchhorn", label: "Green Line C", who: "French horn",    octave: 3, pan: 0.2 },
  "Green-D":  { color: "#00843D", instrument: "tuba",       label: "Green Line D", who: "Tuba",           octave: 2, pan: 0.6 },
  "Green-E":  { color: "#00843D", instrument: "sax",        label: "Green Line E", who: "Saxophone",      octave: 4, pan: -0.6 },
  // Silver Line is bus-classified in GTFS but is rapid transit in spirit — it
  // gets a melodic voice and is kept out of the bus percussion count.
  "741":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 5, pan: -0.4 },
  "742":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 5, pan: -0.15 },
  "743":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 5, pan: 0.1 },
  "746":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 4, pan: 0.35 },
  "749":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 4, pan: -0.25 },
  "751":      { color: "#7C878E", instrument: "vibes",      label: "Silver Line",  who: "Vibraphone",    octave: 4, pan: 0.5 },
};

// Silver Line routes, grouped under one legend row.
export const SILVER_LINE = ["741", "742", "743", "746", "749", "751"];

// Modes matched by prefix / route_type rather than exact id.
export const CR_STYLE    = { color: "#80276C", instrument: "contrabass", who: "Double bass", octave: 2 };
export const FERRY_STYLE = { color: "#008EAA", instrument: "bell", who: "Ship's bell",  octave: 5 };
export const BUS_STYLE   = { color: "#946e2a", who: "Brushes & shaker" };

export const ROUTE_TYPE = { LIGHT_RAIL: 0, HEAVY_RAIL: 1, COMMUTER: 2, BUS: 3, FERRY: 4 };

export function styleForRoute(routeId, routeType) {
  if (RAIL_ROUTES[routeId]) return RAIL_ROUTES[routeId];
  if (routeType === ROUTE_TYPE.COMMUTER || routeId?.startsWith("CR-")) return CR_STYLE;
  if (routeType === ROUTE_TYPE.FERRY || routeId?.startsWith("Boat-")) return FERRY_STYLE;
  return BUS_STYLE;
}

// ---- Music ----
export const BPM = 88;
export const SWING = 0.62;              // position of the off-8th within the beat (0.5 = straight)
export const BEATS_PER_BAR = 4;

// 8-bar modal loop in C. Each entry: chord tones (semitones from C) for the
// bass, and a scale (pentatonic-flavored, collision-safe) for melodic voices.
export const PROGRESSION = [
  { name: "Dm9",   root: 2,  bassNotes: [2, 5, 9, 0],   scale: [2, 5, 7, 9, 12, 14] },
  { name: "Dm9",   root: 2,  bassNotes: [2, 9, 5, 4],   scale: [2, 5, 7, 9, 12, 14] },
  { name: "G13",   root: 7,  bassNotes: [7, 11, 2, 5],  scale: [7, 9, 11, 14, 16, 17] },
  { name: "G13",   root: 7,  bassNotes: [7, 2, 11, 8],  scale: [7, 9, 11, 14, 16, 17] },
  { name: "Cmaj9", root: 0,  bassNotes: [0, 4, 7, 9],   scale: [0, 4, 7, 9, 11, 14] },
  { name: "Cmaj9", root: 0,  bassNotes: [0, 7, 4, 10],  scale: [0, 4, 7, 9, 11, 14] },
  { name: "Am9",   root: 9,  bassNotes: [9, 0, 4, 7],   scale: [9, 12, 14, 16, 19, 21] },
  { name: "Am9",   root: 9,  bassNotes: [9, 4, 0, 3],   scale: [9, 12, 14, 16, 19, 21] },
];

// Map area (rough bounding box of MBTA service, tuned for the rapid-transit core)
export const MAP_BOUNDS = {
  latMin: 42.19, latMax: 42.55,
  lonMin: -71.30, lonMax: -70.90,
};
