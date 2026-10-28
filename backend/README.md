# RA-ONE Backend — Module 1

FastAPI foundation that keeps the Three.js hologram synchronized with a
canonical assistant state (`idle` | `listening` | `thinking` | `speaking`).

Speech recognition, AI reasoning, TTS, and labour-market analysis are **out of
scope** for this module.

## Requirements

- Python 3.12+
- Node / Vite frontend in the parent `ra-one-hologram` folder

## Setup

```bash
cd backend
py -3.12 -m venv .venv
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

## Run

```bash
py -3.12 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- REST base: `http://localhost:8000`
- Health: `GET http://localhost:8000/api/health`
- Status: `GET http://localhost:8000/api/assistant/status`
- Set state (dev only): `POST http://localhost:8000/api/assistant/state`
- WebSocket: `ws://localhost:8000/ws/assistant`

Keep the Vite frontend on `http://localhost:5173`. CORS is restricted to the
origins listed in `.env`.

## WebSocket event

```json
{
  "type": "assistant.state",
  "state": "thinking",
  "timestamp": "2026-10-21T12:00:00Z"
}
```

## Security notes

- `POST /api/assistant/state` is **disabled** when `APP_ENV=production` or
  `DEV_MODE=false`.
- No API keys are shipped to the browser in Module 1.
- All state values are validated with Pydantic.

## Tests

```bash
cd backend
py -3.12 -m pytest -q
```

## Frontend wiring

The Vite app loads `src/api/BackendClient.js`, connects to the WebSocket, and
calls the existing `AssistantStateManager` / `window.RAONE.setState` when
`assistant.state` events arrive. See the parent README for UI usage.

## Desktop build (packaged exe)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_backend.ps1   # → dist\raone-backend\raone-backend.exe
```

`python run_server.py` (or the exe) binds `127.0.0.1` only and writes logs to
`%LOCALAPPDATA%\RAONE\logs`. Env: `PORT`, `RAONE_MODELS_DIR`, `RAONE_STATIC_DIR`
(built frontend to serve at `/`), `RAONE_LOG_DIR`. Details: `../docs/DESKTOP_BUILD_PLAN.md` → Module 4.
