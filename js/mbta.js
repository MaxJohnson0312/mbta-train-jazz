// Data layer: static route/shape fetches at boot, then live vehicles via
// SSE (with API key) or polling (without). Downstream sees a uniform
// event interface: onReset(vehicles[]), onVehicle(vehicle), onRemove(id).

import { API_BASE } from "./config.js";
import { decodePolyline } from "./polyline.js";

const VEHICLE_FILTER = "filter[route_type]=0,1,2,3,4";
const POLL_MS = 5000;

function keyParam(apiKey) {
  return apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
}

// Flatten a JSON:API vehicle resource into what the app needs.
export function parseVehicle(res) {
  const a = res.attributes || {};
  return {
    id: res.id,
    lat: a.latitude,
    lon: a.longitude,
    bearing: a.bearing,
    status: a.current_status,          // INCOMING_AT | STOPPED_AT | IN_TRANSIT_TO
    stopSequence: a.current_stop_sequence,
    directionId: a.direction_id,
    routeId: res.relationships?.route?.data?.id ?? null,
    updatedAt: a.updated_at,
  };
}

export async function fetchRoutes(apiKey) {
  const url = `${API_BASE}/routes?filter[type]=0,1,2,4${keyParam(apiKey)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`routes fetch failed: ${r.status}`);
  const json = await r.json();
  return json.data.map((res) => ({
    id: res.id,
    type: res.attributes.type,
    color: "#" + (res.attributes.color || "888888"),
    longName: res.attributes.long_name,
  }));
}

export async function fetchShapes(routeId, apiKey) {
  const url = `${API_BASE}/shapes?filter[route]=${encodeURIComponent(routeId)}&page[limit]=10${keyParam(apiKey)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const json = await r.json();
  return json.data.map((res) => decodePolyline(res.attributes.polyline));
}

// Subway/light-rail stations for map labels, deduped by name (the API returns
// per-platform records).
export async function fetchStations(apiKey) {
  const url = `${API_BASE}/stops?filter[route_type]=0,1&fields[stop]=name,latitude,longitude${keyParam(apiKey)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const json = await r.json();
  const seen = new Set(), out = [];
  for (const s of json.data) {
    const a = s.attributes;
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push({ name: a.name, lat: a.latitude, lon: a.longitude });
  }
  return out;
}

export class VehicleFeed {
  constructor({ apiKey, onReset, onVehicle, onRemove, onStatus }) {
    this.apiKey = apiKey;
    this.onReset = onReset;
    this.onVehicle = onVehicle;
    this.onRemove = onRemove;
    this.onStatus = onStatus; // ("connecting"|"live"|"polling"|"error", detailText)
    this.es = null;
    this.pollTimer = null;
    this.stopped = false;
    this.backoffMs = 1000;
  }

  start() {
    this.stopped = false;
    if (this.apiKey) this.startStream();
    else this.startPolling();
  }

  stop() {
    this.stopped = true;
    if (this.es) { this.es.close(); this.es = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  startStream() {
    this.onStatus("connecting", "Connecting…");
    const url = `${API_BASE}/vehicles?${VEHICLE_FILTER}${keyParam(this.apiKey)}`;
    const es = new EventSource(url);
    this.es = es;

    es.addEventListener("reset", (e) => {
      this.backoffMs = 1000;
      this.onStatus("live", "Live stream");
      this.onReset(JSON.parse(e.data).map(parseVehicle));
    });
    es.addEventListener("add", (e) => this.onVehicle(parseVehicle(JSON.parse(e.data))));
    es.addEventListener("update", (e) => this.onVehicle(parseVehicle(JSON.parse(e.data))));
    es.addEventListener("remove", (e) => this.onRemove(JSON.parse(e.data).id));

    es.onerror = () => {
      es.close();
      if (this.stopped) return;
      this.onStatus("error", `Reconnecting in ${Math.round(this.backoffMs / 1000)}s`);
      setTimeout(() => { if (!this.stopped) this.startStream(); }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    };
  }

  startPolling() {
    this.onStatus("connecting", "Connecting…");
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/vehicles?${VEHICLE_FILTER}`);
        if (r.status === 429) { this.onStatus("error", "Rate limited"); return; }
        if (!r.ok) throw new Error(`${r.status}`);
        const json = await r.json();
        this.onStatus("polling", "Polling · no API key");
        this.onReset(json.data.map(parseVehicle));
      } catch (err) {
        this.onStatus("error", `Connection error`);
      }
    };
    poll();
    this.pollTimer = setInterval(poll, POLL_MS);
  }
}
