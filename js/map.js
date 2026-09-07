// Canvas map: route polylines + live vehicle dots with smooth motion
// and a pulse when a vehicle's note plays.

import { MAP_BOUNDS, styleForRoute, ROUTE_TYPE } from "./config.js";

export class TransitMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.shapes = [];          // { color, width, points: [[lat,lon],...] }
    this.vehicles = new Map(); // id -> {lat, lon, tLat, tLon, color, size, pulse}
    this.view = { zoom: 1, x: 0, y: 0 };   // screen = base * zoom + offset
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.bindInteraction();
    requestAnimationFrame(() => this.frame());
  }

  bindInteraction() {
    const c = this.canvas;

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(40, Math.max(1, this.view.zoom * factor));
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      // keep the point under the cursor fixed while zooming
      this.view.x = mx - ((mx - this.view.x) / this.view.zoom) * newZoom;
      this.view.y = my - ((my - this.view.y) / this.view.zoom) * newZoom;
      this.view.zoom = newZoom;
      this.clampView();
    }, { passive: false });

    let dragging = null;
    c.addEventListener("pointerdown", (e) => {
      dragging = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = "grabbing";
    });
    c.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.view.x += e.clientX - dragging.x;
      this.view.y += e.clientY - dragging.y;
      dragging = { x: e.clientX, y: e.clientY };
      this.clampView();
    });
    const endDrag = () => { dragging = null; c.style.cursor = "grab"; };
    c.addEventListener("pointerup", endDrag);
    c.addEventListener("pointercancel", endDrag);

    c.addEventListener("dblclick", () => { this.view = { zoom: 1, x: 0, y: 0 }; });
    c.style.cursor = "grab";
  }

  clampView() {
    // keep at least some of the scaled map [0, size*zoom] on screen
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const z = this.view.zoom;
    this.view.x = Math.max(w * 0.5 - w * z, Math.min(this.view.x, w * 0.5));
    this.view.y = Math.max(h * 0.5 - h * z, Math.min(this.view.y, h * 0.5));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.computeProjection();
  }

  computeProjection() {
    const { latMin, latMax, lonMin, lonMax } = MAP_BOUNDS;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const midLat = (latMin + latMax) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180);
    const spanX = (lonMax - lonMin) * cosLat;
    const spanY = latMax - latMin;
    const scale = 0.92 * Math.min(w / spanX, h / spanY);
    this.proj = { cosLat, scale,
      cx: w / 2, cy: h / 2,
      midLon: (lonMin + lonMax) / 2, midLat };
  }

  xy(lat, lon) {
    const p = this.proj, v = this.view;
    const bx = p.cx + (lon - p.midLon) * p.cosLat * p.scale;
    const by = p.cy - (lat - p.midLat) * p.scale;
    return [bx * v.zoom + v.x, by * v.zoom + v.y];
  }

  addShape(routeId, routeType, points, color) {
    const heavy = routeType === ROUTE_TYPE.HEAVY_RAIL || routeType === ROUTE_TYPE.LIGHT_RAIL;
    this.shapes.push({
      color: color || styleForRoute(routeId, routeType).color,
      width: heavy ? 2.4 : 1.1,
      alpha: heavy ? 0.85 : 0.35,
      points,
    });
  }

  upsertVehicle(v, routeType) {
    if (v.lat == null || v.lon == null) return;
    const style = styleForRoute(v.routeId, routeType);
    const isBus = routeType === ROUTE_TYPE.BUS;
    const cur = this.vehicles.get(v.id);
    if (cur) {
      cur.tLat = v.lat; cur.tLon = v.lon;
    } else {
      this.vehicles.set(v.id, {
        lat: v.lat, lon: v.lon, tLat: v.lat, tLon: v.lon,
        color: style.color, size: isBus ? 1.6 : 3.4,
        alpha: isBus ? 0.45 : 1, pulse: 0, routeId: v.routeId,
      });
    }
  }

  removeVehicle(id) { this.vehicles.delete(id); }

  pulseRoute(routeId) {
    for (const v of this.vehicles.values())
      if (v.routeId === routeId) v.pulse = Math.max(v.pulse, 1);
  }

  frame() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, w, h);

    const zScale = Math.pow(this.view.zoom, 0.55);   // sublinear growth when zooming
    for (const s of this.shapes) {
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * zScale;
      ctx.beginPath();
      s.points.forEach(([lat, lon], i) => {
        const [x, y] = this.xy(lat, lon);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const v of this.vehicles.values()) {
      v.lat += (v.tLat - v.lat) * 0.06;   // ease toward reported position
      v.lon += (v.tLon - v.lon) * 0.06;
      const [x, y] = this.xy(v.lat, v.lon);
      const size = v.size * zScale;
      if (v.pulse > 0.01) {
        ctx.globalAlpha = v.pulse * 0.5;
        ctx.fillStyle = v.color;
        ctx.beginPath();
        ctx.arc(x, y, size + (10 * (1 - v.pulse) + 4) * zScale, 0, Math.PI * 2);
        ctx.fill();
        v.pulse *= 0.94;
      }
      ctx.globalAlpha = v.alpha;
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(() => this.frame());
  }
}
