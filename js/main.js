// Wiring: boot, settings, and the data → music/map hookup.

import { RAIL_ROUTES, ROUTE_TYPE, styleForRoute, BUS_STYLE, CR_STYLE, FERRY_STYLE, DEFAULT_API_KEY } from "./config.js";
import { VehicleFeed, fetchRoutes, fetchShapes } from "./mbta.js";
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
  return ROUTE_TYPE.BUS;
}

function updateBusDensity() {
  const now = Date.now();
  for (const [id, t] of state.busSeen) if (now - t > 60000) state.busSeen.delete(id);
  state.band.busDensity = Math.min(1, state.busSeen.size / 150);
}

function handleVehicle(v) {
  const type = routeTypeOf(v.routeId);
  state.map.upsertVehicle(v, type);

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
    if (isArrival) state.band.triggerHorn(progress);
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
      for (const v of vehicles) handleVehicle(v);
      $("vehicle-count").textContent = `${vehicles.length} vehicles`;
      updateBusDensity();
    },
    onVehicle: (v) => { handleVehicle(v); updateBusDensity(); },
    onRemove: (id) => { state.map.removeVehicle(id); state.prev.delete(id); state.busSeen.delete(id); },
  });
  state.feed.start();
}

function buildLegend() {
  const seen = new Set();
  const rows = [];
  for (const [id, s] of Object.entries(RAIL_ROUTES)) {
    const name = s.label.replace(/ [BCDE]$/, "");
    const key = s.instrument + name;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id, color: s.color, label: name, who: s.who });
  }
  rows.push({ id: "CR", color: CR_STYLE.color, label: "Commuter Rail", who: CR_STYLE.who });
  rows.push({ id: "Boat", color: FERRY_STYLE.color, label: "Ferries", who: FERRY_STYLE.who });
  rows.push({ id: "Bus", color: BUS_STYLE.color, label: "Buses", who: BUS_STYLE.who });
  $("legend").innerHTML = rows.map((r) =>
    `<div class="legend-item" data-route="${r.id}">
       <span class="swatch" style="background:${r.color};color:${r.color}"></span>
       <span>${r.label}</span><span class="who">${r.who}</span>
     </div>`).join("");
}

function glowLegend(routeId) {
  const key = routeId.startsWith("Green-") ? "Green-B"
            : routeId.startsWith("CR-") ? "CR"
            : routeId.startsWith("Boat-") ? "Boat" : routeId;
  const el = document.querySelector(`.legend-item[data-route="${key}"]`);
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

// ---- UI ----
$("start-btn").addEventListener("click", async () => {
  $("start-panel").classList.add("hidden");
  $("controls").classList.remove("hidden");
  await state.band.start();
  state.band.onNotePlayed = (routeId) => { glowLegend(routeId); state.map.pulseRoute(routeId); };
  state.band.onBar = (chord) => { $("now-playing").textContent = `now playing: ${chord} · live from the T`; };
  buildLegend();
  startFeed();
  loadShapes();   // async; map lines appear as they arrive
  setInterval(updateBusDensity, 5000);
});

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

$("rhythm-toggle").addEventListener("change", (e) => { state.band.enabled.rhythm = e.target.checked; });
$("buses-toggle").addEventListener("change", (e) => { state.band.enabled.buses = e.target.checked; });
$("cr-toggle").addEventListener("change", (e) => { state.band.enabled.cr = e.target.checked; });
$("ferry-toggle").addEventListener("change", (e) => { state.band.enabled.ferry = e.target.checked; });
