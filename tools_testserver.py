"""Serve the site and capture selftest results posted back by the page."""
import http.server, socketserver, os, sys, urllib.parse

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
LOG = sys.argv[3]
open(LOG, "w").close()

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith("/report?"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(q.get("msg", [""])[0] + "\n")
            self.send_response(204); self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as httpd:
    httpd.serve_forever()
