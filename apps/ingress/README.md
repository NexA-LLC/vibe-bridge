# Ingress

Ingress is the optional source-side process for Vibe Bridge. It receives external events and enqueues
JobSpec-like payloads into the control plane with `POST /jobs`.

Supported sources:
- Generic webhook: `POST /ingress/jobs`
- Slack webhook or slash command: `POST /ingress/slack`
- LINE webhook: `POST /ingress/line`
- AWS SQS polling
- WebSocket client

Environment:
- `VIBE_BRIDGE_API_BASE` (required)
- `VIBE_BRIDGE_API_TOKEN` (optional; matches the control plane token)
- `VIBE_BRIDGE_INGRESS_SOURCES` (comma-separated; `webhook`, `slack`, `line`, `sqs`, `websocket`)
- `VIBE_BRIDGE_INGRESS_PORT` (default `3910`)
- `VIBE_BRIDGE_INGRESS_TOKEN` (optional bearer token for generic webhook)
- `VIBE_BRIDGE_INGRESS_DEFAULT_KIND` (default `ai`)
- `VIBE_BRIDGE_INGRESS_DEFAULT_PHASE` (default `plan`)
- `VIBE_BRIDGE_INGRESS_AI_BACKEND` (default `codex-cli`)

Generic webhook:
- `VIBE_BRIDGE_INGRESS_WEBHOOK_PATH` (default `/ingress/jobs`)
- Payload can be a JobSpec-like object, `{job:{...}}`, or plain text.

Slack:
- `SLACK_SIGNING_SECRET` or `VIBE_BRIDGE_SLACK_SIGNING_SECRET`
- `VIBE_BRIDGE_SLACK_PATH` (default `/ingress/slack`)
- Slash command `text` and event `event.text` become `kind=ai`, `phase=plan` jobs.

LINE:
- `LINE_CHANNEL_SECRET` or `VIBE_BRIDGE_LINE_CHANNEL_SECRET`
- `VIBE_BRIDGE_LINE_PATH` (default `/ingress/line`)
- Text message events become `kind=ai`, `phase=plan` jobs.

SQS:
- `VIBE_BRIDGE_SQS_QUEUE_URL` (required for `sqs`)
- `AWS_REGION` / `AWS_DEFAULT_REGION` / `VIBE_BRIDGE_SQS_REGION`
- `VIBE_BRIDGE_SQS_WAIT_TIME_SEC` (default `20`)
- `VIBE_BRIDGE_SQS_VISIBILITY_TIMEOUT_SEC` (optional)
- `VIBE_BRIDGE_SQS_MAX_MESSAGES` (default `5`, max `10`)

WebSocket:
- `VIBE_BRIDGE_WS_URL` (required for `websocket`)
- `VIBE_BRIDGE_WS_TOKEN` (optional bearer token)
- `VIBE_BRIDGE_WS_RECONNECT_SEC` (default `5`)

Local LINE or Slack development:
- Run ingress locally and expose it with ngrok or Cloudflare Tunnel.
- Configure the provider webhook URL to the tunnel URL plus `/ingress/line` or `/ingress/slack`.
- For production, prefer a small deployed ingress endpoint that posts to the control plane.
