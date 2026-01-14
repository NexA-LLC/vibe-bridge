# Brain Runner (Python)

This is an optional Python “brain” runner for Vibe Bridge.
It polls the control plane for `kind=brain` + `phase=plan` jobs, generates a plan via an OpenAI-compatible
`/chat/completions` endpoint, and completes the job with `artifactsInline.plan`.

## Why

- Keep the Node runner focused on local execution (CLI/MCP/Vibe Kanban).
- Add a separate “brain” process in Python without changing the protocol.

## Requirements

- Python 3.10+
- No extra dependencies (stdlib only)

## Environment

Control plane:
- `VIBE_BRIDGE_API_BASE` (e.g. `http://127.0.0.1:3900`)
- `VIBE_BRIDGE_API_TOKEN` (matches `API_TOKEN` on the control plane; optional if the API is unauthenticated)

LLM (OpenAI-compatible):
- `VIBE_BRIDGE_LLM_BASE_URL` (default: `http://127.0.0.1:1234/v1`)
- `VIBE_BRIDGE_LLM_API_KEY` (default: `sk-local`)
- `VIBE_BRIDGE_LLM_MODEL` (default: `auto`)
- `VIBE_BRIDGE_LLM_TIMEOUT_MS` (default: `20000`) or `VIBE_BRIDGE_LLM_TIMEOUT_SEC` (default: `20`)

## Run

```bash
python3 vibe-bridge/apps/brain-py/brain_runner.py --poll-interval-sec 2
```

To receive jobs from FlowAlign, set FlowAlign’s `FLOWALIGN_VIBE_BRIDGE_DEFAULT_KIND=brain`
and point `FLOWALIGN_VIBE_BRIDGE_API_BASE_URL` at the control plane.

If you run the Node runner at the same time, configure it to not lease `kind=brain` jobs
(e.g. `VIBE_BRIDGE_RUNNER_KINDS=cli,mcp,vibeKanban,vibeKanban.mcp`).
