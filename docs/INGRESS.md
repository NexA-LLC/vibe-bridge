# Ingress Sources

Vibe Bridge keeps input and execution separate:

- `apps/ingress` receives events from external systems and creates jobs in the control plane.
- `apps/api` stores, leases, and approves jobs.
- `apps/runner` pulls jobs and executes them locally.

This keeps local execution outbound-only while still allowing many ways to start work.

## Source Patterns

Recommended source tiers:

1. Direct API: systems that can call `POST /jobs` should use the control plane directly.
2. Generic webhook: simple HTTP producers can call `apps/ingress` at `/ingress/jobs`.
3. Queue: AWS SQS is the durable path for production fan-in and retry.
4. Realtime: WebSocket is useful for dev tools and long-lived control channels.
5. Chat: Slack and LINE are thin adapters that turn text events into `kind=ai` plan jobs.

## Payload Shape

Ingress accepts:

```json
{
  "tenantId": "default",
  "kind": "ai",
  "phase": "plan",
  "params": {
    "aiBackend": "codex-cli",
    "prompt": "Draft a migration plan"
  }
}
```

It also accepts `{ "job": { ... } }` envelopes and plain text prompts. SQS messages may be plain
JobSpec-like JSON or SNS-style envelopes with a JSON `Message` field.

Ingress attaches metadata at `params.vibeBridgeIngress`:

```json
{
  "source": "sqs",
  "sourceMessageId": "abc",
  "receivedAt": "2026-06-01T00:00:00.000Z"
}
```

## Slack And LINE

Slack and LINE both require public HTTPS webhook URLs. For local development:

```bash
pnpm run build
VIBE_BRIDGE_API_BASE=http://127.0.0.1:3900 \
VIBE_BRIDGE_API_TOKEN=dev \
VIBE_BRIDGE_INGRESS_SOURCES=slack,line \
pnpm run start:ingress

ngrok http 3910
```

Then configure:

- Slack request URL: `https://<ngrok-host>/ingress/slack`
- LINE webhook URL: `https://<ngrok-host>/ingress/line`

For production, use a stable deployed ingress or tunnel endpoint. LINE itself is global, but a local
runner can still execute the work because the LINE webhook only creates jobs; execution remains pull-based.

## SQS

SQS is the best first production queue because it gives durable retry and works across services:

```bash
VIBE_BRIDGE_API_BASE=https://bridge.example.com \
VIBE_BRIDGE_API_TOKEN=... \
VIBE_BRIDGE_INGRESS_SOURCES=sqs \
VIBE_BRIDGE_SQS_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/123456789012/vibe-bridge \
AWS_REGION=ap-northeast-1 \
pnpm run start:ingress
```

The ingress deletes messages only after the job is accepted by the control plane.

## WebSocket

WebSocket mode connects to an upstream URL and treats each message as a JobSpec-like payload:

```bash
VIBE_BRIDGE_INGRESS_SOURCES=websocket \
VIBE_BRIDGE_WS_URL=wss://source.example.com/vibe-bridge \
VIBE_BRIDGE_WS_TOKEN=... \
pnpm run start:ingress
```

When a message includes `id` or `messageId`, ingress sends an ack:

```json
{"type":"ack","messageId":"...", "jobId":"..."}
```
