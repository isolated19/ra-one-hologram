# Module 2 — Offline LLM Engine

## Stack
- **Runtime:** [Ollama](https://ollama.com) on `http://127.0.0.1:11434` only
- **Preferred:** `qwen3:1.7b` (~1.4 GB download, ~3 GB RAM CPU)
- **Fallback:** `qwen3:0.6b` (~0.5 GB download, ~1.5 GB RAM CPU)
- **Service:** `app/llm/LocalLLMService.py`
- **API:** `/api/llm/*`

## Security
- Client refuses non-localhost base URLs
- `trust_env=False` (ignores HTTP proxies)
- **No automatic model download** — use `scripts/setup_ollama.ps1` and type `YES`
- Do not expose Ollama to the public network

## CPU defaults (i7-8650U / 16 GB)
| Setting | Default |
|---------|---------|
| `num_ctx` | 2048 |
| `num_predict` (max output) | 120 |
| `num_thread` | 4 |
| `temperature` | 0.5 |
| `think` | false (short spoken answers) |
| history turns | 6 |

## Setup
```powershell
cd backend
.\scripts\setup_ollama.ps1
```

## Verify
```text
GET  /api/llm/health
POST /api/llm/chat  {"text":"Who are you?"}
```

Production Piper TTS / hologram pipeline is unchanged. Voice↔LLM wiring is Module 9.
