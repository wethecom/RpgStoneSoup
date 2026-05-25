#!/usr/bin/env python3
"""Run Crawl Web as its own desktop window.

The game loads its data with `fetch()`, which browsers block from
`file://`, so this serves the web-game folder on a private localhost
port and opens it in a **chromeless browser window** -- Microsoft Edge
(or Chrome) launched in `--app` mode: no tabs, no address bar, its own
window. Edge's engine is Chromium, the same engine CEF embeds.

    python web-game/desktop.py

When bundled by build_desktop.py the static files travel inside the
executable and are served from the PyInstaller extraction folder, so
RpgStoneSoup.exe is a single double-click app.
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import subprocess
import sys
import tempfile
import threading

WINDOW_TITLE = "RPG Stone Soup"


def web_dir() -> str:
    """The folder that holds index.html: the PyInstaller bundle when
    frozen into an .exe, otherwise this script's own directory."""
    if getattr(sys, "frozen", False):
        return sys._MEIPASS                       # type: ignore[attr-defined]
    return os.path.dirname(os.path.abspath(__file__))


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    """A static file handler that does not spam the console."""
    def log_message(self, *args):                 # noqa: D102
        pass


def start_server(directory: str) -> int:
    """Serve `directory` on a free localhost port; return the port.

    The server runs on a daemon thread, so it dies with the app."""
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return port


def find_browser() -> str | None:
    """Locate a Chromium-family browser that supports `--app`."""
    candidates = [
        r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
    ]
    for raw in candidates:
        path = os.path.expandvars(raw)
        if os.path.exists(path):
            return path
    return None


def selftest() -> int:
    """Verify the bundle end to end without opening a window: serve the
    files and fetch them back. Run as `RpgStoneSoup.exe --selftest`; the
    result is written to a temp file since a windowed exe has no
    console. Returns a process exit code."""
    import urllib.request

    root = web_dir()
    port = start_server(root)
    lines, ok = [], True
    for rel in ("index.html", "game.js", "style.css", "game-data.json",
                "vaults.json", "tiles/manifest.json"):
        try:
            resp = urllib.request.urlopen(
                f"http://127.0.0.1:{port}/{rel}", timeout=5)
            size = len(resp.read())
            good = resp.status == 200 and size > 0
            lines.append(f"  {'ok  ' if good else 'FAIL'} {rel} ({size} b)")
            ok = ok and good
        except Exception as exc:                  # noqa: BLE001
            lines.append(f"  FAIL {rel}: {exc}")
            ok = False
    lines.append("SELFTEST PASSED" if ok else "SELFTEST FAILED")
    report = "\n".join(lines)
    out = os.path.join(tempfile.gettempdir(), "crawlweb-selftest.txt")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(report + "\n")
    print(report)
    return 0 if ok else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    root = web_dir()
    if not os.path.exists(os.path.join(root, "index.html")):
        sys.exit(f"index.html not found in {root}")
    port = start_server(root)
    url = f"http://127.0.0.1:{port}/"

    browser = find_browser()
    if browser:
        # a dedicated profile keeps this a standalone app window,
        # separate from the user's normal browsing session
        profile = os.path.join(tempfile.gettempdir(), "crawlweb-profile")
        proc = subprocess.Popen([
            browser,
            f"--app={url}",
            f"--user-data-dir={profile}",
            "--window-size=1180,840",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        proc.wait()                # block until the app window closes
    else:
        # no Chromium browser found -- fall back to the default browser
        import webbrowser
        webbrowser.open(url)
        threading.Event().wait()   # keep the server alive
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
