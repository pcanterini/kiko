"""Runs the official `pocket-tts serve` (FastAPI, POST /tts streams 24 kHz s16 WAV).

Only addition: exit as soon as stdin closes, so the server dies with the Node
process that spawned it (src/core/pocket-tts.ts) instead of lingering on the port.
Usage: .venv/bin/python serve.py --host 127.0.0.1 --port 8737 [--default-voice alba]
"""

import os
import sys
import threading


def _exit_when_parent_goes() -> None:
    try:
        while sys.stdin.buffer.read(1024):
            pass
    finally:
        os._exit(0)


if os.environ.get("POCKET_TTS_WATCH_STDIN", "1") == "1":
    threading.Thread(target=_exit_when_parent_goes, daemon=True).start()

from pocket_tts.main import cli_app  # noqa: E402

cli_app(["serve", *sys.argv[1:]], prog_name="pocket-tts")
