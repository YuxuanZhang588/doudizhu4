# Four-player Dou Dizhu (no jokers) — PoC

## Run (web UI + game-data storage)

Run the bundled server (stdlib only). It serves the UI and stores per-user game data:

```bash
cd /home/david/clawd/projects/doudizhu4
python3 server.py --port 8099
```

Then open:
- http://localhost:8099

## Player profiles + data storage

On the page, set **玩家名** (e.g. `mom`). Each user gets their **own SQLite database file**:

- `projects/doudizhu4/data/<username>.sqlite`

## API (debug)

- `GET /api/health`
- `POST /api/record_game`
- `GET /api/games?user=<username>&limit=50`

Notes:
- Username allows only `a-zA-Z0-9_-` (1–32 chars).
- If you don’t set a username, the game will still run, but it won’t store records.
