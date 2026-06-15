#!/usr/bin/env python3
"""serve.py — zero-dependency launcher for the Radar View page.

Serves the static files in this folder AND reverse-proxies data so the browser
never hits a blocked cross-origin request:

  Local ADS-B device:
    /adsb/data/aircraft.json  ->  http://<DEVICE>/data/aircraft.json
    /adsb/db/<prefix>.json    ->  http://<DEVICE>/db/<prefix>.json

  Internet feeds that lack CORS (allow-listed hosts only):
    /feed?url=https://api.adsb.lol/v2/...   ->  forwarded with CORS added

Only GET is allowed; the device proxy is locked to the single fixed DEVICE host and
the feed proxy to a fixed allow-list (no open proxy, no path traversal).

Usage:
    python3 serve.py                 # http://127.0.0.1:8000
    python3 serve.py --port 8080
    python3 serve.py --host 0.0.0.0  # expose on the LAN (kiosk / other devices)
    python3 serve.py --device http://192.168.2.74:8080
"""
import argparse
import os
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

DEVICE = os.environ.get("ADSB_DEVICE", "http://192.168.2.74:8080")
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# Internet feed hosts the /feed proxy is permitted to forward to.
FEED_HOSTS = {
    "api.adsb.lol",
    "api.airplanes.live",
    "adsbexchange-com1.p.rapidapi.com",
}


class Handler(SimpleHTTPRequestHandler):
    device = DEVICE  # overridden in main()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def _forward(self, target, extra_headers=None):
        try:
            req = urllib.request.Request(target, method="GET")
            if extra_headers:
                for k, v in extra_headers.items():
                    if v:
                        req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=12) as up:
                body = up.read()
                self.send_response(200)
                self.send_header("Content-Type", up.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, "upstream: %s" % e.reason)
        except Exception as e:  # noqa: BLE001
            self.send_error(502, "upstream unreachable: %s" % e)

    def _proxy(self):
        # Map /adsb/<path> -> device/<path>. Reject anything suspicious.
        rel = self.path[len("/adsb/"):].split("#", 1)[0]
        if ".." in rel or rel.startswith("/"):
            self.send_error(400, "bad proxy path")
            return
        target = self.device.rstrip("/") + "/" + rel
        if urlsplit(target).netloc != urlsplit(self.device).netloc:
            self.send_error(400, "proxy host not allowed")
            return
        self._forward(target)

    def _feed_proxy(self):
        # /feed?url=<full internet feed url>, restricted to FEED_HOSTS.
        qs = parse_qs(urlsplit(self.path).query)
        target = (qs.get("url") or [""])[0]
        host = urlsplit(target).netloc
        if urlsplit(target).scheme not in ("http", "https") or host not in FEED_HOSTS:
            self.send_error(403, "feed host not allowed")
            return
        # forward RapidAPI auth headers from the browser if present (e.g. ADSBExchange)
        extra = {}
        for h in ("X-RapidAPI-Key", "X-RapidAPI-Host"):
            if self.headers.get(h):
                extra[h] = self.headers.get(h)
        self._forward(target, extra)

    def do_GET(self):
        if self.path.startswith("/adsb/"):
            self._proxy()
        elif self.path.startswith("/feed?") or self.path == "/feed":
            self._feed_proxy()
        else:
            super().do_GET()

    def end_headers(self):
        # let the page reach adsbdb etc. without surprises; harmless for same-origin
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter logging
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="Radar View launcher")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    ap.add_argument("--device", default=DEVICE, help="ADS-B device base URL")
    args = ap.parse_args()

    Handler.device = args.device

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/" % ("localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port)
    print("Radar View serving %s" % url)
    print("Proxying /adsb/* -> %s" % args.device)
    print("Feed proxy /feed?url= -> %s" % ", ".join(sorted(FEED_HOSTS)))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
