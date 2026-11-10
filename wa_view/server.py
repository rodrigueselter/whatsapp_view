"""Servidor HTTP (stdlib) que expõe o modelo em JSON, as mídias e o frontend."""
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

STATIC_DIR = Path(__file__).parent / "static"
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "wa_view/0.1"
        protocol_version = "HTTP/1.1"

        # -------------------------------------------------------- utilities
        def log_message(self, fmt, *args):  # silencia log por requisição
            if os.environ.get("WA_VIEW_DEBUG"):
                super().log_message(fmt, *args)

        def _send_json(self, payload, status=HTTPStatus.OK):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _not_found(self):
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

        def _send_file(self, path, mime=None, download_name=None):
            size = path.stat().st_size
            mime = mime or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            start, end = 0, size - 1
            status = HTTPStatus.OK
            range_header = self.headers.get("Range")
            if range_header:
                m = _RANGE.match(range_header)
                if m:
                    if m.group(1):
                        start = int(m.group(1))
                        if m.group(2):
                            end = min(int(m.group(2)), size - 1)
                    elif m.group(2):
                        start = max(size - int(m.group(2)), 0)
                    if start > end or start >= size:
                        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    status = HTTPStatus.PARTIAL_CONTENT
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if download_name:
                self.send_header("Content-Disposition", f'inline; filename="{download_name}"')
            self.end_headers()
            if self.command == "HEAD":
                return
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(1 << 16, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

        # ----------------------------------------------------------- routes
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            try:
                self._route(unquote(urlparse(self.path).path))
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _route(self, path):
            if path in ("/", "/index.html"):
                return self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                target = (STATIC_DIR / path[len("/static/"):]).resolve()
                if STATIC_DIR.resolve() in target.parents and target.is_file():
                    return self._send_file(target)
                return self._not_found()
            if path == "/api/summary":
                return self._send_json(store.summary())
            if path == "/api/chats":
                return self._send_json(store.chat_list())
            m = re.fullmatch(r"/api/chats/(\d+)", path)
            if m:
                chat = store.chat(int(m.group(1)))
                return self._send_json(chat) if chat else self._not_found()
            m = re.fullmatch(r"/api/chats/(\d+)/messages", path)
            if m:
                if store.chat(int(m.group(1))) is None:
                    return self._not_found()
                return self._send_json(store.messages(int(m.group(1))))
            m = re.fullmatch(r"/api/media/(\d+)/hash", path)
            if m:
                digest = store.media_hash(int(m.group(1)))
                return self._send_json({"sha256": digest}) if digest else self._not_found()
            m = re.fullmatch(r"/media/(\d+)", path)
            if m:
                media_id = int(m.group(1))
                file_path = store.media_path(media_id)
                if not file_path:
                    return self._not_found()
                from .extractor import sniff_mime
                return self._send_file(file_path, sniff_mime(file_path), file_path.name)
            return self._not_found()

    return Handler


def serve(store, host="127.0.0.1", port=8000):
    httpd = ThreadingHTTPServer((host, port), make_handler(store))
    httpd.daemon_threads = True
    return httpd
