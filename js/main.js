// Wiring: boot, settings, and the data → music/map hookup.

import { RAIL_ROUTES, ROUTE_TYPE, styleForRoute, BUS_STYLE, CR_STYLE, FERRY_STYLE,
         DEFAULT_API_KEY, SILVER_LINE } from "./config.js";
import { VehicleFeed, fetchRoutes, fetchShapes, fetchStations } from "./mbta.js";
import { Band } from "./music.js";
import { TransitMap } from "./map.js";

const $ = (id) => document.getElementById(id);

const state = {
  apiKey: localStorage.getItem("mbta_api_key") || DEFAULT_API_KEY,
  band: new Band(),
  map: new TransitMap($("map")),
  feed: null,
  prev: new Map(),           // vehicle id -> {status, stopSequence}
  maxSeq: new Map(),         // route id -> max stop_sequence seen (progress estimate)
  busSeen: new Map(),        // bus vehicle id -> last-seen ms
};

function routeTypeOf(routeId) {
  if (!routeId) return ROUTE_TYPE.BUS;
  if (routeId.startsWith("CR-")) return ROUTE_TYPE.COMMUTER;
  if (routeId.startsWith("Boat-")) return ROUTE_TYPE.FERRY;
  if (routeId === "Red" || routeId === "Orange" || routeId === "Blue") return ROUTE_TYPE.HEAVY_RAIL;
  if (routeId === "Mattapan" || routeId.startsWith("Green-")) return ROUTE_TYPE.LIGHT_RAIL;
  // Silver Line is a bus in GTFS but plays as rapid transit here.
  if (SILVER_LINE.includes(routeId)) return ROUTE_TYPE.LIGHT_RAIL;
  return ROUTE_TYPE.BUS;
}

// Which legend row a route belongs to.
function legendKeyOf(routeId) {
  if (!routeId) return "Bus";
  if (SILVER_LINE.includes(routeId)) return "Silver";
  if (routeId.startsWith("CR-")) return "CR";
  if (routeId.startsWith("Boat-")) return "Boat";
  return RAIL_ROUTES[routeId] ? routeId : "Bus";
}

// Live per-line vehicle counts shown in the legend.
const counts = new Map();      // legend key -> Set of vehicle ids
function countVehicle(routeId, vehicleId) {
  const key = legendKeyOf(routeId);
  if (!counts.has(key)) counts.set(key, new Set());
  counts.get(key).add(vehicleId);
}
function uncountVehicle(vehicleId) {
  for (const set of counts.values()) set.delete(vehicleId);
}
function renderCounts() {
  for (const [key, set] of counts) {
    const el = document.querySelector(`.legend-item[data-route="${key}"] .count`);
    if (el) el.textContent = set.size || "";
  }
}

function updateBusDensity() {
  const now = Date.now();
  for (const [id, t] of state.busSeen) if (now - t > 60000) state.busSeen.delete(id);
  state.band.busDensity = Math.min(1, state.busSeen.size / 150);
}

function handleVehicle(v) {
  const type = routeTypeOf(v.routeId);
  state.map.upsertVehicle(v, type);
  countVehicle(v.routeId, v.id);

  if (type === ROUTE_TYPE.BUS) {
    state.busSeen.set(v.id, Date.now());
    return;
  }

  // progress along route from stop_sequence (normalized by max seen)
  if (v.stopSequence != null) {
    const prevMax = state.maxSeq.get(v.routeId) || 1;
    if (v.stopSequence > prevMax) state.maxSeq.set(v.routeId, v.stopSequence);
  }
  const progress = Math.min(1, (v.stopSequence || 0) / (state.maxSeq.get(v.routeId) || 1));

  const prev = state.prev.get(v.id);
  const changed = !prev || prev.status !== v.status || prev.stopSequence !== v.stopSequence;
  state.prev.set(v.id, { status: v.status, stopSequence: v.stopSequence });
  if (!changed || !prev) return;   // first sighting = no note (avoids reset blast)

  const isArrival = v.status === "STOPPED_AT";
  if (type === ROUTE_TYPE.COMMUTER) {
    if (isArrival) state.band.triggerBassLine(progress);
  } else if (type === ROUTE_TYPE.FERRY) {
    state.band.triggerBell();
  } else {
    state.band.triggerVehicleNote(v.routeId, progress, v.directionId, isArrival);
  }
}

function setStatus(kind, text) {
  const el = $("conn-status");
  el.textContent = text;
  el.className = "badge" + (kind === "live" || kind === "polling" ? " live" : kind === "error" ? " error" : "");
}

function startFeed() {
  if (state.feed) state.feed.stop();
  state.prev.clear();
  state.feed = new VehicleFeed({
    apiKey: state.apiKey,
    onStatus: setStatus,
    onReset: (vehicles) => {
      counts.clear();                       // rebuild from the fresh snapshot
      for (const v of vehicles) handleVehicle(v);
      $("vehicle-count").textContent = `${vehicles.length} vehicles`;
      updateBusDensity();
      renderCounts();
    },
    onVehicle: (v) => { handleVehicle(v); updateBusDensity(); },
    onRemove: (id) => {
      state.map.removeVehicle(id); state.prev.delete(id);
      state.busSeen.delete(id); uncountVehicle(id);
    },
  });
  state.feed.start();
}

function buildLegend() {
  const rows = [];
  for (const [id, s] of Object.entries(RAIL_ROUTES)) {
    if (SILVER_LINE.includes(id)) continue;      // grouped into one row below
    rows.push({ id, color: s.color, label: s.label, who: s.who });
  }
  const sl = RAIL_ROUTES[SILVER_LINE[0]];
  rows.push({ id: "Silver", color: sl.color, label: sl.label, who: sl.who });
  rows.push({ id: "CR", color: CR_STYLE.color, label: "Commuter Rail", who: CR_STYLE.who });
  rows.push({ id: "Boat", color: FERRY_STYLE.color, label: "Ferries", who: FERRY_STYLE.who });
  rows.push({ id: "Bus", color: BUS_STYLE.color, label: "Buses", who: BUS_STYLE.who });
  $("legend").innerHTML =
    `<div class="legend-head">
       <span class="legend-hint">Click an instrument to mute it</span>
       <button id="legend-collapse" title="Collapse legend">▾</button>
     </div>
     <div id="legend-rows">` +
    rows.map((r) =>
    `<div class="legend-item" data-route="${r.id}" title="Click to mute ${r.label}">
       <span class="swatch" style="background:${r.color};color:${r.color}"></span>
       <span class="name">${r.label}</span><span class="who">${r.who}</span>
       <span class="count"></span>
     </div>`).join("") +
    `</div>`;

  $("legend-collapse").addEventListener("click", (e) => {
    e.stopPropagation();
    const collapsed = $("legend").classList.toggle("collapsed");
    e.target.textContent = collapsed ? "▸" : "▾";
    e.target.title = collapsed ? "Expand legend" : "Collapse legend";
  });

  $("legend").addEventListener("click", (e) => {
    const item = e.target.closest(".legend-item");
    if (!item) return;
    const key = item.dataset.route;
    let muted;
    if (key === "Bus") {                        // buses are the drummer, not a voice
      state.band.enabled.buses = !state.band.enabled.buses;
      muted = !state.band.enabled.buses;
      $("buses-toggle").checked = state.band.enabled.buses;
    } else if (key === "Silver") {              // one row, six underlying routes
      muted = state.band.toggleRouteMute(SILVER_LINE[0]);
      for (const id of SILVER_LINE.slice(1)) {
        if (muted) state.band.mutedRoutes.add(id);
        else state.band.mutedRoutes.delete(id);
      }
    } else {
      muted = state.band.toggleRouteMute(key);
    }
    item.classList.toggle("muted", muted);
  });
}

function glowLegend(routeId) {
  const el = document.querySelector(`.legend-item[data-route="${legendKeyOf(routeId)}"]`);
  if (!el) return;
  el.classList.add("playing");
  setTimeout(() => el.classList.remove("playing"), 400);
}

async function loadShapes() {
  const routes = await fetchRoutes(state.apiKey).catch(() => []);
  for (const r of routes) {
    const shapes = await fetchShapes(r.id, state.apiKey).catch(() => []);
    for (const pts of shapes) state.map.addShape(r.id, r.type, pts, r.color);
  }
}

// iOS silent-switch workaround: Web Audio is treated as "ambient" sound and is
// hard-muted by the ring/silent switch. A playing (silent, looping) <audio>
// element moves the audio session to the "playback" category, which ignores the
// switch — same trick as unmute-ios-audio. Must start inside the tap gesture.
function unlockMediaSession() {
  const a = new Audio(
    // 0.1 s of silence, 8 kHz mono 16-bit WAV (generated, verified header)
    "data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAA" +
    "A".repeat(2132)
  );
  a.loop = true;
  a.setAttribute("playsinline", "");
  a.play().catch(() => {});   // best effort; harmless if blocked
}

// ---- UI ----
$("start-btn").addEventListener("click", async () => {
  unlockMediaSession();
  await state.band.start();

  // The band plays immediately using synthesis. Nothing below may ever wait on
  // the sample download — a slow or failed load must not take the app with it.
  $("start-panel").classList.add("hidden");
  $("controls").classList.remove("hidden");
  state.band.onNotePlayed = (routeId) => { glowLegend(routeId); state.map.pulseRoute(routeId); };
  state.band.onBar = (chord) => { $("now-playing").textContent = `Now playing: ${chord} · live from the T`; };
  buildLegend();
  startFeed();
  loadShapes();   // async; map lines appear as they arrive
  fetchStations(state.apiKey).then((stops) => state.map.addStations(stops)).catch(() => {});
  setInterval(updateBusDensity, 5000);
  setInterval(renderCounts, 2000);
  renderCounts();

  // Synthesized voices are the default. Recorded samples are opt-in and load in
  // the background; if they never arrive, the synth keeps playing regardless.
  if (localStorage.getItem("use_samples") === "1") loadSamplesInBackground();
});

function loadSamplesInBackground() {
  const badge = $("sample-status");
  badge.classList.remove("hidden");
  badge.textContent = "Loading samples… 0%";
  state.band.loadSamples((done, total) => {
    badge.textContent = `Loading samples… ${Math.round((done / total) * 100)}%`;
  }).then((ok) => {
    badge.textContent = ok ? "Sampled instruments" : "Synth instruments";
    setTimeout(() => badge.classList.add("hidden"), 5000);
  }).catch(() => {
    badge.textContent = "Synth instruments";
    setTimeout(() => badge.classList.add("hidden"), 5000);
  });
}

// ?autostart=1 — for the Raspberry Pi kiosk, where nobody is there to click.
// Chromium must be launched with --autoplay-policy=no-user-gesture-required
// for the audio context to be allowed to start without a real gesture.
if (new URLSearchParams(location.search).get("autostart") === "1") {
  window.addEventListener("load", () => $("start-btn").click());
}

$("settings-btn").addEventListener("click", () => $("settings-panel").classList.toggle("hidden"));
$("settings-close").addEventListener("click", () => $("settings-panel").classList.add("hidden"));

const keyInput = $("api-key-input");
keyInput.value = state.apiKey;
keyInput.addEventListener("change", () => {
  const v = keyInput.value.trim();
  state.apiKey = v || DEFAULT_API_KEY;   // cleared field = back to site default
  if (v) localStorage.setItem("mbta_api_key", v);
  else localStorage.removeItem("mbta_api_key");
  if (state.feed) startFeed();   // reconnect with the new key
});

$("volume-slider").addEventListener("input", (e) => state.band.setVolume(e.target.value / 100));

let muted = false;
$("mute-btn").addEventListener("click", () => {
  muted = !muted;
  state.band.setVolume(muted ? 0 : $("volume-slider").value / 100);
  $("mute-btn").textContent = muted ? "🔇" : "🔊";
});

const samplesToggle = $("samples-toggle");
samplesToggle.checked = localStorage.getItem("use_samples") === "1";
samplesToggle.addEventListener("change", (e) => {
  localStorage.setItem("use_samples", e.target.checked ? "1" : "0");
  if (e.target.checked && state.band.ctx) loadSamplesInBackground();
  else if (!e.target.checked) { state.band.buffers = {}; state.band.useSamples = false; }
});

$("rhythm-toggle").addEventListener("change", (e) => { state.band.enabled.rhythm = e.target.checked; });
$("buses-toggle").addEventListener("change", (e) => { state.band.enabled.buses = e.target.checked; });
$("cr-toggle").addEventListener("change", (e) => { state.band.enabled.cr = e.target.checked; });
$("ferry-toggle").addEventListener("change", (e) => { state.band.enabled.ferry = e.target.checked; });
