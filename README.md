# Vibe Bridge

Vibe Bridge is an outbound-only runner and control plane for connecting cloud workflows to local developer
tooling without opening inbound ports. It can route jobs to MCP servers, CLIs, Vibe Kanban, Codex, Cursor,
Claude Code, OpenAI-compatible local LLMs, or explicitly allowlisted commands.

In practical terms, Vibe Bridge lets a cloud app, chat tool, queue, or webhook
say "please do this work" while the actual work still happens on a developer's
machine through a local runner.

## What It Solves

Many useful developer tools only work well on a local machine because that is
where the repository, credentials, editor sessions, MCP servers, and AI coding
tools already live. Exposing that machine to inbound traffic is risky.

Vibe Bridge keeps the local side pull-based:

```text
external source -> control plane job queue <- local runner -> local tools
```

The source never opens a socket to the runner. The runner leases jobs over
outbound HTTPS, executes them locally, and reports status, logs, plans, or
results back to the control plane.

## Common Use Cases

- Trigger Codex, Cursor, Claude Code, or a local LLM from a workflow system.
- Turn Slack, LINE, SQS, WebSocket, or webhook messages into plan jobs.
- Let a local runner work on private repositories without uploading the repo to
  the control plane.
- Review a generated plan before creating an execute job.
- Route jobs to allowlisted local commands or MCP/Vibe Kanban adapters.

Japanese docs:
- `README.ja.md`
- `docs/ARCHITECTURE.ja.md`
- `docs/INGRESS.md`
- `SECURITY.md`
- `docs/THREAT_MODEL.md`

This repo is a Node/TypeScript-first monorepo. The runner lives in the developer or customer environment and
polls for jobs; the control plane and web UI can run anywhere reachable over outbound HTTPS.

## Concept

The core idea is simple: keep the runner thin, keep the protocol stable, and keep trust boundaries clear.
Local tools stay local. The cloud only orchestrates.

Plan/execute workflow:
- Jobs can be split into `plan` and `execute` phases.
- Plan output is stored in the control plane and can be approved before execution.

Read the deep concept doc here: `docs/CONCEPT.md`.

## Principles

- Pull > push. The runner long-polls for work and never exposes inbound ports.
- Thin runner. It only leases jobs, executes via adapters (MCP/CLI), and reports results.
- Protocol first. JobSpec/ResultSpec are stable so we can add Python brains later.
- Clear trust boundary. Secrets stay on the runner host; only outbound HTTPS is required.
- Plan before execute. External inputs should default to `phase=plan`; execution should be approved or scoped.

## Repo Layout

- `apps/api`: control plane API (jobs, lease, auth, logs)
- `apps/ingress`: optional source adapters (webhook, Slack, LINE, SQS, WebSocket)
- `apps/runner`: customer-side runner (polling, execution, upload; CLI/Vibe Kanban/AI backend adapters)
- `apps/brain-py`: optional Python brain runner (plan generation for `kind=brain`)
- `apps/web`: web UI (future; dev UI is currently served by `apps/api` at `/ui`)
- `packages/shared`: shared JobSpec/ResultSpec types
- `docs/`: concept and architecture notes

## Status

Early MVP. API + runner work for local dev; the API serves a minimal Dev UI at `/ui`.

## Security

Vibe Bridge can execute local developer tools, so deployments should be treated
as local execution infrastructure. Start with [SECURITY.md](SECURITY.md) and the
[threat model](docs/THREAT_MODEL.md) before exposing ingress adapters or tunnels.

## Quickstart (dev)

This repo is TypeScript-first. Build once, then run the API and runner.

1) Install deps (once)
- From `vibe-bridge/`, install workspace dependencies:
  - `pnpm install`

2) Build
- `pnpm run build`

3) Run API
- `API_TOKEN=dev PORT=3900 pnpm run start:api`

3.5) Open Dev UI
- `http://127.0.0.1:3900/ui` (set API Token to `dev` if `API_TOKEN=dev`)

4) (Optional) Run Ingress (in another shell)
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_INGRESS_SOURCES=webhook pnpm run start:ingress`

5) Run Runner (in another shell)
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_WORKSPACE_ROOT=/absolute/path pnpm run start:runner`

6) (Optional) Run Brain Runner (plan generation)
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev python3 apps/brain-py/brain_runner.py`

AI jobs:
- Use `kind=ai` with `params.aiBackend=codex-cli|codex-app-server|cursor-cli|cursor-api|claude-code|local-llm|openai-compatible|command`.
- `codex-cli` runs Codex CLI. `codex-app-server` uses the local Codex app-server daemon. `cursor-cli` runs Cursor Agent locally, while `cursor-api` targets a configurable Cursor/OpenAI-compatible API endpoint. `claude-code` runs Claude Code in print mode. `local-llm` and `openai-compatible` call `/chat/completions`-style APIs. `command` runs an explicit runner-side command template.

## Create a Job

After starting the API, create a plan job with:

```bash
curl -sS http://127.0.0.1:3900/jobs \
  -H 'Authorization: Bearer dev' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "default",
    "kind": "ai",
    "phase": "plan",
    "context": "Inspect this repository and propose a safe README improvement.",
    "params": {
      "prompt": "Inspect this repository and propose a safe README improvement.",
      "aiBackend": "codex-cli"
    }
  }'
```

Then start a runner configured for plan jobs:

```bash
VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 \
VIBE_BRIDGE_API_TOKEN=dev \
VIBE_BRIDGE_WORKSPACE_ROOT=~/.vibe-bridge/work \
VIBE_BRIDGE_RUNNER_PHASES=plan \
pnpm run start:runner
```

Open `http://127.0.0.1:3900/ui` to inspect the job, runner events, and plan
output.

## Safe Defaults for Demos

For local demos or public tunnel experiments:

- Keep external inputs as `phase=plan`.
- Point ngrok or Cloudflare Tunnel only at `apps/ingress`.
- Set `VIBE_BRIDGE_INGRESS_TOKEN` for generic webhooks.
- Set Slack or LINE signing secrets before enabling those adapters.
- Use `VIBE_BRIDGE_COMMANDS_STRICT=1` before enabling command execution.
- Scope runners with `VIBE_BRIDGE_RUNNER_TENANT_ID`,
  `VIBE_BRIDGE_RUNNER_KINDS`, and `VIBE_BRIDGE_RUNNER_PHASES`.

## License

MIT
