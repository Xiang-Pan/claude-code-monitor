#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["gradio"]
# ///
"""Create a public URL for claude-monitor using Gradio's FRP tunnel."""

import asyncio
import inspect
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_port():
    try:
        with open(os.path.join(ROOT, "config.json")) as f:
            return json.load(f).get("server", {}).get("port", 3456)
    except (FileNotFoundError, json.JSONDecodeError):
        return 3456


def server_healthy(port):
    try:
        r = urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=3)
        return r.status == 200
    except Exception:
        return False


def open_tunnel(port):
    """Create FRP tunnel via Gradio's internal networking module."""
    try:
        from gradio.networking import setup_tunnel
    except ImportError:
        sys.exit("[share] ERROR: gradio not installed. Run: uv run share.py")

    result = setup_tunnel("127.0.0.1", port, "", None, None)
    if inspect.isawaitable(result):
        loop = asyncio.new_event_loop()
        return loop.run_until_complete(result)
    return result


def main():
    port = load_port()
    server_proc = None

    # Start Express if not already running
    if not server_healthy(port):
        print(f"[share] Starting Express server on port {port}...")
        server_proc = subprocess.Popen(["node", "server/index.js"], cwd=ROOT)
        for _ in range(30):
            time.sleep(1)
            if server_healthy(port):
                break
        else:
            server_proc.terminate()
            sys.exit("[share] ERROR: Server failed to start within 30s")

    print(f"[share] Server healthy on port {port}")
    print("[share] Opening Gradio FRP tunnel...")

    url = open_tunnel(port)

    print(f"\n  Public URL: {url}")
    print(f"  Tunneling to localhost:{port}\n")
    print("  Press Ctrl+C to stop.\n")

    # Graceful shutdown
    def shutdown(*_):
        print("\n[share] Shutting down...")
        if server_proc:
            server_proc.terminate()
            server_proc.wait(timeout=5)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Block until server exits or user interrupts
    while True:
        time.sleep(1)
        if server_proc and server_proc.poll() is not None:
            sys.exit("[share] Server process exited unexpectedly")


if __name__ == "__main__":
    main()
