# API (Control Plane)

The control plane owns job creation, leasing, retries, and auditing. It is the source of truth for
job state. Runners only pull from here.

Planned endpoints:
- `GET /jobs/next` (long-poll)
- `POST /jobs/:id/heartbeat`
- `POST /jobs/:id/complete`
- `POST /jobs/:id/logs`
- `POST /runners/register`
