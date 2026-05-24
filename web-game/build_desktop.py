#!/usr/bin/env python3
"""Bundle Crawl Web into a single standalone desktop executable.

    pip install pyinstaller
    python web-game/build_desktop.py

Produces web-game/dist/CrawlWeb.exe (Windows) -- a self-contained app
that needs no Python. The HTML / JS / JSON and the whole tiles/ folder
are packed inside the executable; desktop.py serves them locally and
opens them in a chromeless Edge / Chrome window. The browser engine is
whatever Chromium-family browser the machine already has (Edge ships
with Windows), so the executable itself stays small.

Re-run after build_game_data.py / build_tiles.py / build_vaults.py so
the bundled data matches the latest export.
"""

from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# static files the running game fetches / loads
DATA_FILES = ["index.html", "game.js", "style.css",
              "game-data.json", "vaults.json"]
DATA_DIRS = ["tiles"]


def main() -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        sys.exit("PyInstaller is not installed -- run:\n"
                 "    pip install pyinstaller")

    missing = [f for f in DATA_FILES
               if not os.path.exists(os.path.join(HERE, f))]
    if missing:
        sys.exit("missing generated files: " + ", ".join(missing) +
                 "\nrun build_game_data.py / build_tiles.py /"
                 " build_vaults.py first")

    sep = ";" if os.name == "nt" else ":"        # PyInstaller --add-data
    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--onefile", "--windowed",
        "--name", "CrawlWeb",
        "--distpath", os.path.join(HERE, "dist"),
        "--workpath", os.path.join(HERE, "build"),
        "--specpath", HERE,
    ]
    for name in DATA_FILES + DATA_DIRS:
        src = os.path.join(HERE, name)
        dest = "." if name in DATA_FILES else name
        args += ["--add-data", f"{src}{sep}{dest}"]
    args.append(os.path.join(HERE, "desktop.py"))

    print("PyInstaller:\n  " + " ".join(args))
    rc = subprocess.call(args)
    if rc == 0:
        exe = os.path.join(HERE, "dist",
                           "CrawlWeb.exe" if os.name == "nt" else "CrawlWeb")
        print(f"\nbuilt {exe}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
