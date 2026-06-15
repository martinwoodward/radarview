#!/usr/bin/env python3
"""serve.py — zero-dependency launcher for the Radar View page.

Serves the static files in this folder AND reverse-proxies the ADS-B device so the
browser never hits a cross-origin request:

    /adsb/data/aircraft.json  ->  http://<DEVICE>/data/aircraft.json
    /adsb/db/<prefix>.json    ->  http://<DEVICE>/db/<prefix>.json

Only GET to the single fixed DEVICE host is allowed (no open proxy, no path traversal).

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
from urllib.parse import urlsplit

DEVICE = os.environ.get("ADSB_DEVICE", "http://192.168.2.74:8080")
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    device = DEVICE  # overridden in main()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

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
        try:
            req = urllib.request.Request(target, method="GET")
            with urllib.request.urlopen(req, timeout=10) as up:
                body = up.read()
                self.send_response(200)
                ctype = up.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, "device: %s" % e.reason)
        except Exception as e:  # noqa: BLE001
            self.send_error(502, "device unreachable: %s" % e)

    def do_GET(self):
        if self.path.startswith("/adsb/"):
            self._proxy()
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
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
