# Concept

## Intent

Vibe Bridge exists to connect internal services to local-only automation without opening inbound ports.
It lets multiple services produce work and a local runner execute that work through MCP, Vibe Kanban,
or other CLIs. The runner stays in the customer environment; the cloud only orchestrates.

## Non-goals

- It is not an LLM or agent brain. That can be added later as a separate process.
- It does not run heavy compute in the cloud; it delegates to local executors.
- It does not require inbound network access to the runner.

## System Model

Vibe Bridge is a hub with adapters on both sides.

Sources (cloud side):
- Internal services that produce jobs (case systems, workflows, schedulers).
- A shared control plane API can normalize jobs from all sources.

Executors (local side):
- MCP servers (local-only).
- Vibe Kanban tasks.
- CLI tools (codex, gemini, custom scripts).

Runner (customer environment):
- Pulls jobs from the control plane.
- Leases a job, executes via an adapter, and reports results.

Web UI (cloud side):
- Runner enrollment, job history, logs, and diagnostics.

## Core Loop

1. A source creates a JobSpec in the control plane.
2. A runner long-polls `GET /jobs/next`.
3. The control plane leases a job and returns it to the runner.
4. The runner executes via an adapter and streams logs.
5. The runner reports completion with artifacts.

## Pull Model (Long Poll)

- Long-poll 30-60 seconds per request.
- Exponential backoff with jitter on empty responses.
- Heartbeat extends the lease; expired leases are re-queued.

This keeps the runner outbound-only and avoids inbound firewall changes.

## Job Lifecycle

Queued -> Leased -> Running -> Completed/Failed/Canceled

The control plane is the source of truth. A job is safe to retry if the lease expires.

## Job Events (Multi-update)

Some executors (like Vibe Kanban) can emit multiple updates for the same ticket. These should be
posted as JobEvents while the JobResult remains a single final record.

## Plan -> Execute Gate

Jobs can be split into a plan phase and an execute phase:

1. A plan job runs locally and emits plan text (stored in the control plane).
2. A human approves the plan in the control plane UI.
3. The control plane creates an execute job that references the approved plan.

This keeps repo access local while still enabling review and external notifications.

Plan text can be persisted in Postgres for auditability. For large plans, store the body in object
storage (S3/MinIO) and keep only a reference in the control plane.

## Protocol (Stable Boundary)

JobSpec and ResultSpec should remain stable so we can add new executors and a Python brain later.

Example JobSpec (Vibe Kanban create_task):

```json
{
  "id": "job_01J9QG0J1C1C4H80Y9YFWB51Z3",
  "tenantId": "t_123",
  "kind": "vibeKanban.mcp",
  "params": {
    "tool": "create_task",
    "project_id": "proj_42",
    "title": "[flowlog:0192f08d-1a2b-7c3d-8e4f-123456789abc] Add user profile page",
    "description": "…"
  },
  "idempotencyKey": "b6b2f38c-8e8e-49b8-8b52-1b4d1f2b0a43",
  "timeoutSec": 1800,
  "requestedAt": "2025-01-05T12:34:56Z"
}
```

Example ResultSpec:

```json
{
  "jobId": "job_01J9QG0J1C1C4H80Y9YFWB51Z3",
  "status": "completed",
  "finishedAt": "2025-01-05T12:49:12Z",
  "artifacts": {
    "patchRef": "s3://bucket/patches/job_01J9QG0J.diff",
    "reportRef": "s3://bucket/reports/job_01J9QG0J.json"
  },
  "logsRef": "s3://bucket/logs/job_01J9QG0J.txt"
}
```

## Adapters

Source adapters (cloud side) normalize job creation. Executor adapters (runner side) translate a
JobSpec into a local action.

Executor adapter examples:
- `mcp`: talk to a local MCP server via stdio.
- `vibe-kanban`: create/start tasks and pull results.
- `cli`: spawn a local CLI and capture output.

## Security and Trust

- The runner owns local secrets. The cloud never sees them.
- The runner requires only outbound HTTPS.
- Tokens can be scoped per tenant and rotated.
- Logs and artifacts are treated as sensitive.

## Packaging Strategy

- Start with Node/TypeScript for speed and ecosystem fit.
- Keep the runner thin to reduce dependency risk.
- Add Python brain later via a stable protocol boundary.

## Why Node First

- MCP and the surrounding tool ecosystem are strongest in Node.
- The runner is mostly I/O (polling, spawning, uploading).
- A shared type system reduces drift between UI, API, and runner.

## Future: Brain as a Separate Process

A Python brain can be added later for evaluation, retries, and optimization without changing the
runner protocol. This keeps the system adaptable as AI tooling shifts.
