#!/usr/bin/env python3
"""Simple static+API server for the Dou Dizhu web PoC.

- Serves the existing static site (index.html + src/) from this directory.
- Adds JSON API endpoints to persist per-user game data into per-user SQLite DB files.

No external deps (stdlib only).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

# Import AI agent
try:
    from ai_agent import get_agent, MODEL_INFO as _AI_MODEL_INFO
    AI_ENABLED = True
except Exception as e:
    print(f"Warning: AI agent not available: {e}")
    AI_ENABLED = False
    _AI_MODEL_INFO = {}

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"

# Global AI agent instance
AI_AGENT = None

USER_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,32}$")


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_user(u: str) -> str:
    u = (u or "").strip()
    if not USER_RE.match(u):
        raise ValueError("invalid user (allowed: 1-32 chars a-zA-Z0-9_-)")
    return u


def db_path_for_user(user: str) -> Path:
    return DATA_DIR / f"{user}.sqlite"


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          game_id TEXT,
          started_at TEXT,
          ended_at TEXT,
          winner_p INTEGER,
          landlord_p INTEGER,
          payload_json TEXT NOT NULL
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);")
    conn.commit()


class Handler(SimpleHTTPRequestHandler):
    # Serve files relative to project dir
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self) -> None:
        # Avoid "some clients stuck on old HTML/JS" issues by disabling caching for this PoC.
        # (APIs already send no-store.)
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        return super().end_headers()

    def _send_json(self, status: int, obj: Any) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._send_json(200, {"ok": True, "time": iso_now()})

        if parsed.path == "/api/model_info":
            import ai_agent as _ai_mod
            # Ensure agent (and MODEL_INFO) is initialized
            if AI_ENABLED:
                try:
                    get_agent()
                except Exception:
                    pass
            info = dict(getattr(_ai_mod, 'MODEL_INFO', {}))
            info['ai_enabled'] = AI_ENABLED
            if not info.get('name'):
                info['name'] = 'unknown'
            return self._send_json(200, info)

        if parsed.path == "/api/games":
            qs = parse_qs(parsed.query)
            user = sanitize_user((qs.get("user") or [""])[0])
            limit = int((qs.get("limit") or ["50"])[0])
            limit = max(1, min(limit, 500))

            DATA_DIR.mkdir(parents=True, exist_ok=True)
            dbp = db_path_for_user(user)
            if not dbp.exists():
                return self._send_json(200, {"user": user, "games": []})

            conn = sqlite3.connect(str(dbp))
            ensure_schema(conn)
            rows = conn.execute(
                "SELECT id, created_at, game_id, started_at, ended_at, winner_p, landlord_p FROM games ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            conn.close()
            games = [
                {
                    "id": r[0],
                    "created_at": r[1],
                    "game_id": r[2],
                    "started_at": r[3],
                    "ended_at": r[4],
                    "winner_p": r[5],
                    "landlord_p": r[6],
                }
                for r in rows
            ]
            return self._send_json(200, {"user": user, "games": games})

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/get_ai_action":
            try:
                global AI_AGENT
                if not AI_ENABLED:
                    return self._send_json(503, {"ok": False, "error": "AI not available"})
                
                # Initialize AI agent on first use
                if AI_AGENT is None:
                    try:
                        AI_AGENT = get_agent()
                    except Exception as e:
                        return self._send_json(500, {"ok": False, "error": f"Failed to load AI: {e}"})
                
                body = self._read_json() or {}
                game_state = body.get("game_state")
                player_position = body.get("player_position")
                
                if game_state is None or player_position is None:
                    return self._send_json(400, {"ok": False, "error": "Missing game_state or player_position"})
                
                # Get AI action
                import time
                start_time = time.time()
                action = AI_AGENT.get_action(game_state, player_position)
                elapsed = time.time() - start_time
                
                return self._send_json(200, {
                    "ok": True,
                    "action": action,
                    "elapsed_ms": int(elapsed * 1000)
                })
            except Exception as e:
                import traceback
                traceback.print_exc()
                return self._send_json(500, {"ok": False, "error": str(e)})

        if parsed.path == "/api/record_game":
            try:
                body = self._read_json() or {}
                user = sanitize_user(body.get("user", ""))
                payload = body.get("payload")
                if payload is None:
                    raise ValueError("missing payload")

                DATA_DIR.mkdir(parents=True, exist_ok=True)
                dbp = db_path_for_user(user)
                conn = sqlite3.connect(str(dbp))
                ensure_schema(conn)

                game_id = payload.get("game_id") if isinstance(payload, dict) else None
                started_at = payload.get("started_at") if isinstance(payload, dict) else None
                ended_at = payload.get("ended_at") if isinstance(payload, dict) else None
                winner_p = payload.get("winner_p") if isinstance(payload, dict) else None
                landlord_p = payload.get("landlord_p") if isinstance(payload, dict) else None

                conn.execute(
                    "INSERT INTO games(created_at, game_id, started_at, ended_at, winner_p, landlord_p, payload_json) VALUES (?,?,?,?,?,?,?)",
                    (
                        iso_now(),
                        game_id,
                        started_at,
                        ended_at,
                        winner_p,
                        landlord_p,
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
                conn.commit()
                rowid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                conn.close()

                return self._send_json(200, {"ok": True, "user": user, "id": rowid})
            except Exception as e:
                return self._send_json(400, {"ok": False, "error": str(e)})

        return self._send_json(404, {"ok": False, "error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8099)
    args = ap.parse_args()

    os.chdir(str(HERE))

    # Eagerly load AI model so first request isn't slow and MODEL_INFO is ready
    if AI_ENABLED:
        print("Pre-loading AI model...")
        try:
            get_agent()
            print("AI model loaded.")
        except Exception as e:
            print(f"Warning: AI model pre-load failed: {e}")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving Dou Dizhu web + API on http://{args.host}:{args.port} (dir={HERE})")
    print("API: POST /api/record_game , GET /api/games?user=NAME , GET /api/health")
    if AI_ENABLED:
        print("     POST /api/get_ai_action (AI-powered decisions)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
