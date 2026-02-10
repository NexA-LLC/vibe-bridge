# API (Control Plane)

The control plane owns job creation, leasing, retries, and auditing. It is the source of truth for
job state and plan approvals. Runners only pull from here.

Environment:
- `API_TOKEN` (optional, bearer auth)
- `PORT` (default 3900)
- `LEASE_TTL_SEC` (default 300)
- `PLAN_WEBHOOK_URLS` (optional, comma-separated URLs)
- `PLAN_WEBHOOK_TOKEN` (optional bearer token for plan webhooks)
- `PLAN_STORAGE_BACKEND` (optional, `memory` or `postgres`)
- `PLAN_INLINE_MAX_CHARS` (optional, max chars to keep inline; `0` disables)
- `PLAN_TABLE` (optional, default `vibe_bridge_plans`)
- `DATABASE_URL` (required when `PLAN_STORAGE_BACKEND=postgres`)
- `JOB_STORAGE_BACKEND` (optional, `memory` or `postgres`)
- `DATABASE_URL` (required when `JOB_STORAGE_BACKEND=postgres`)

Notes:
- When `PLAN_STORAGE_BACKEND=postgres`, the plan table must already exist. Create it via your normal human-run DB migration workflow (this repo avoids runtime DDL).
- The `PLAN_TABLE` override is only supported for the default `vibe_bridge_plans` schema.

Endpoints:
- `GET /ui` (minimal Dev UI for local testing)
- `POST /jobs` (create job)
- `GET /jobs` (list jobs; supports `tenantId`, `kinds`, `phases`, `states`, `limit`)
- `GET /jobs/next` (lease next job, supports `waitSec`, `leaseTtlSec`, `tenantId`, `kinds`, `phases`)
- `GET /jobs/:id` (inspect job)
- `POST /jobs/:id/heartbeat` (extend lease)
- `POST /jobs/:id/events` (append event logs or questions)
- `POST /jobs/:id/complete` (mark job done and attach artifacts)
- `POST /jobs/:id/approve` (approve plan and optionally spawn execute job)

Suggested webhook endpoints (placeholder):
- `https://caseflow.example.com/api/integrations/vibe-bridge/plan`
- `https://flowalign.example.com/api/integrations/vibe-bridge/plan`
- `https://flowlog.example.com/api/integrations/vibe-bridge/plan`
