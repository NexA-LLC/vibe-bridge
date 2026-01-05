# Vibe Bridge

Vibe Bridge is a pull-based runner and control plane that bridges internal services to local-only tooling
(MCP servers, Vibe Kanban, and CLIs) without opening inbound ports.

This repo is a Node/TypeScript-first monorepo. The runner lives in customer environments and polls for
jobs; the control plane and web UI live in our infrastructure.

## Concept

The core idea is simple: keep the runner thin, keep the protocol stable, and keep trust boundaries clear.
Local tools stay local. The cloud only orchestrates.

Planned workflow addition:
- Jobs can be split into `plan` and `execute` phases.
- Plan output is stored in the control plane and can be approved before execution.

Read the deep concept doc here: `docs/CONCEPT.md`.

## Principles

- Pull > push. The runner long-polls for work and never exposes inbound ports.
- Thin runner. It only leases jobs, executes via adapters (MCP/CLI), and reports results.
- Protocol first. JobSpec/ResultSpec are stable so we can add Python brains later.
- Clear trust boundary. Secrets stay on the runner host; only outbound HTTPS is required.

## Repo Layout

- `apps/api`: control plane API (jobs, lease, auth, logs)
- `apps/runner`: customer-side runner (polling, execution, upload)
- `apps/web`: web UI (history, runners, tokens)
- `packages/shared`: shared JobSpec/ResultSpec types
- `docs/`: concept and architecture notes

## Status

Skeleton only. The goal of this first commit is to lock the concept and structure before code grows.

## Quickstart (dev)

This repo is TypeScript-first. Build once, then run the API and runner.

1) Install deps (once)
- From `vibe-bridge/`, install workspace dependencies using your usual Node workspace tool (npm/pnpm).

2) Build
- `npm run build`

3) Run API
- `API_TOKEN=dev PORT=3900 npm run start:api`

4) Run Runner (in another shell)
- `VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 VIBE_BRIDGE_API_TOKEN=dev VIBE_BRIDGE_WORKSPACE_ROOT=/absolute/path npm run start:runner`
