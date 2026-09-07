// Leaflet-backed map: faint dark city basemap (Carto "no labels" tiles — roads
// appear as you zoom, never any road text), MBTA route lines, live vehicle dots
// with eased motion and note pulses, and station names that fade in on zoom.

import { styleForRoute, ROUTE_TYPE, CARTO_KEY } from "./config.js";

const LABEL_ZOOM = 14;    // station names visible at/after this zoom
const DOT_ZOOM = 12;      // station dots visible at/after this zoom

export class TransitMap {
  constructor(el) {
    this.map = L.map(el, {
      center: [42.352, -71.065],
      zoom: 12,
      minZoom: 10,
      maxZoom: 18,
      zoomControl: false,
      attributionControl: true,
    });

    L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
        detectRetina: true,     // {r} -> @2x on high-DPI screens (phones especially)
        opacity: 0.55,          // keep the city faint; the transit is the subject
      }).addTo(this.map);

    this.renderer = L.canvas({ padding: 0.3 });   // one canvas for all vector layers
    this.vehicles = new Map();  // id -> {marker, lat, lon, tLat, tLon, routeId, pulse, baseRadius}
    this.stationDots = L.layerGroup();
    this.stationLabels = L.layerGroup();

    this.map.on("zoomend", () => this.syncStationVisibility());
    requestAnimationFrame(() => this.frame());
  }

  addShape(routeId, routeType, points, color) {
    const heavy = routeType === ROUTE_TYPE.HEAVY_RAIL || routeType === ROUTE_TYPE.LIGHT_RAIL;
    L.polyline(points, {
      renderer: this.renderer,
      color: color || styleForRoute(routeId, routeType).color,
      weight: heavy ? 3 : 1.5,
      opacity: heavy ? 0.8 : 0.3,
      interactive: false,
    }).addTo(this.map);
  }

  addStations(stops) {
    for (const s of stops) {
      L.circleMarker([s.lat, s.lon], {
        renderer: this.renderer,
        radius: 3, color: "#e8e6df", weight: 1,
        fillColor: "#0b0e14", fillOpacity: 1, opacity: 0.8,
        interactive: false,
      }).addTo(this.stationDots);

      const label = L.marker([s.lat, s.lon], {
        interactive: false,
        icon: L.divIcon({
          className: "station-label",
          html: s.name,
          iconSize: null,
          iconAnchor: [-6, 6],   // sit just right of the dot
        }),
      });
      this.stationLabels.addLayer(label);
    }
    this.syncStationVisibility();
  }

  syncStationVisibility() {
    const z = this.map.getZoom();
    const want = (layer, on) =>
      on ? (this.map.hasLayer(layer) || layer.addTo(this.map))
         : (this.map.hasLayer(layer) && layer.remove());
    want(this.stationDots, z >= DOT_ZOOM);
    want(this.stationLabels, z >= LABEL_ZOOM);
  }

  upsertVehicle(v, routeType) {
    if (v.lat == null || v.lon == null) return;
    const cur = this.vehicles.get(v.id);
    if (cur) {
      cur.tLat = v.lat; cur.tLon = v.lon;
      return;
    }
    const style = styleForRoute(v.routeId, routeType);
    const isBus = routeType === ROUTE_TYPE.BUS;
    const baseRadius = isBus ? 2 : 5;
    const marker = L.circleMarker([v.lat, v.lon], {
      renderer: this.renderer,
      radius: baseRadius,
      color: style.color, weight: isBus ? 0 : 1.5,
      fillColor: style.color,
      fillOpacity: isBus ? 0.4 : 0.9,
      opacity: 1,
      interactive: false,
    }).addTo(this.map);
    this.vehicles.set(v.id, {
      marker, baseRadius, routeId: v.routeId,
      lat: v.lat, lon: v.lon, tLat: v.lat, tLon: v.lon, pulse: 0,
    });
  }

  removeVehicle(id) {
    const v = this.vehicles.get(id);
    if (v) { v.marker.remove(); this.vehicles.delete(id); }
  }

  pulseRoute(routeId) {
    for (const v of this.vehicles.values())
      if (v.routeId === routeId) v.pulse = Math.max(v.pulse, 1);
  }

  frame() {
    for (const v of this.vehicles.values()) {
      const dLat = v.tLat - v.lat, dLon = v.tLon - v.lon;
      const moving = Math.abs(dLat) > 1e-7 || Math.abs(dLon) > 1e-7;
      if (moving) {
        v.lat += dLat * 0.06;
        v.lon += dLon * 0.06;
        v.marker.setLatLng([v.lat, v.lon]);
      }
      if (v.pulse > 0.01) {
        v.marker.setRadius(v.baseRadius + 8 * v.pulse);
        v.pulse *= 0.92;
        if (v.pulse <= 0.01) { v.pulse = 0; v.marker.setRadius(v.baseRadius); }
      }
    }
    requestAnimationFrame(() => this.frame());
  }
}
