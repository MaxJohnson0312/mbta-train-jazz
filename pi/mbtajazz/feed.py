"""MBTA live vehicle feed.

Streams the V3 API's server-sent events (one long-lived connection) and falls
back to polling if no API key is available. Mirrors js/mbta.js.
"""

import json
import logging
import threading
import time

import requests

from . import config as C

log = logging.getLogger("mbtajazz.feed")

VEHICLE_FILTER = "filter[route_type]=0,1,2,3,4"


def parse_vehicle(res):
    a = res.get("attributes") or {}
    rel = (res.get("relationships") or {}).get("route") or {}
    data = rel.get("data") or {}
    return dict(
        id=res.get("id"),
        lat=a.get("latitude"),
        lon=a.get("longitude"),
        status=a.get("current_status"),
        stop_sequence=a.get("current_stop_sequence"),
        direction_id=a.get("direction_id"),
        route_id=data.get("id"),
    )


class VehicleFeed(threading.Thread):
    """Calls on_reset(list) / on_vehicle(v) / on_remove(id) from its own thread."""

    daemon = True

    def __init__(self, api_key, on_reset, on_vehicle, on_remove, on_status=None):
        super().__init__(name="mbta-feed")
        self.api_key = api_key
        self.on_reset = on_reset
        self.on_vehicle = on_vehicle
        self.on_remove = on_remove
        self.on_status = on_status or (lambda *_: None)
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def run(self):
        backoff = 1.0
        while not self._stop.is_set():
            try:
                if self.api_key:
                    self._stream()
                else:
                    self._poll_once()
                    self._stop.wait(5.0)
                    continue
                backoff = 1.0
            except Exception as e:                       # network hiccup, DNS, 5xx
                if self._stop.is_set():
                    break
                log.warning("feed error (%s); retrying in %.0fs", e, backoff)
                self.on_status("error", f"reconnecting in {backoff:.0f}s")
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 60.0)

    # --- server-sent events ----------------------------------------------
    def _stream(self):
        url = f"{C.API_BASE}/vehicles?{VEHICLE_FILTER}"
        headers = {"accept": "text/event-stream", "x-api-key": self.api_key}
        self.on_status("connecting", "opening stream")
        with requests.get(url, headers=headers, stream=True, timeout=(10, 90)) as r:
            r.raise_for_status()
            self.on_status("live", "live stream")
            event, payload = None, []
            for raw in r.iter_lines(decode_unicode=True):
                if self._stop.is_set():
                    return
                if raw is None:
                    continue
                line = raw.strip()
                if line == "":                            # blank line = dispatch
                    if event and payload:
                        self._dispatch(event, "".join(payload))
                    event, payload = None, []
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    payload.append(line[5:].strip())
            # server closed the stream; run() will reconnect
            raise ConnectionError("stream closed by server")

    def _dispatch(self, event, data):
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return
        if event == "reset":
            self.on_reset([parse_vehicle(v) for v in obj])
        elif event in ("add", "update"):
            self.on_vehicle(parse_vehicle(obj))
        elif event == "remove":
            self.on_remove(obj.get("id"))

    # --- keyless fallback -------------------------------------------------
    def _poll_once(self):
        url = f"{C.API_BASE}/vehicles?{VEHICLE_FILTER}"
        r = requests.get(url, timeout=20)
        if r.status_code == 429:
            self.on_status("error", "rate limited — use an API key")
            time.sleep(30)
            return
        r.raise_for_status()
        self.on_status("polling", "polling every 5s (no key)")
        self.on_reset([parse_vehicle(v) for v in r.json()["data"]])
