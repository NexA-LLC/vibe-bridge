# Security Policy

Vibe Bridge connects remote job sources to tools that run on a local developer
machine. Treat every deployment as a local execution system, not as a passive
webhook relay.

## Supported Versions

Security fixes are handled on the default branch first. Until the project cuts
versioned releases, consumers should track the latest commit on `main`.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately instead of opening a public
issue with exploit details.

- Email: security@nexa-llc.com
- Repository: https://github.com/NexA-LLC/vibe-bridge

Include the affected commit, deployment mode, enabled ingress sources, runner
configuration, reproduction steps, and expected impact.

## Secure Baseline

Use this baseline before connecting Vibe Bridge to real Slack, LINE, SQS,
WebSocket, ngrok, Cloudflare Tunnel, or public webhook endpoints.

- Set a strong `API_TOKEN`; do not expose the control plane without bearer auth.
- Keep the runner outbound-only. Do not expose the runner process to inbound
  traffic.
- Prefer `phase=plan` for external inputs. Run `phase=execute` only after a
  human or trusted system approves the plan.
- Set runner filters for the intended scope:
  - `VIBE_BRIDGE_RUNNER_TENANT_ID`
  - `VIBE_BRIDGE_RUNNER_KINDS`
  - `VIBE_BRIDGE_RUNNER_PHASES`
- Use command allowlists for arbitrary command execution:
  - `VIBE_BRIDGE_COMMANDS_FILE`
  - `VIBE_BRIDGE_COMMANDS_LOCAL_FILE`
  - `VIBE_BRIDGE_COMMANDS_STRICT=1`
- Do not pass secrets in `JobSpec.context`, `params.prompt`, command strings, or
  inline artifacts.
- Keep `VIBE_BRIDGE_WORKSPACE_ROOT` in a dedicated directory, separate from
  unrelated source trees and user documents.

## Ingress Requirements

- Generic webhooks should set `VIBE_BRIDGE_INGRESS_TOKEN`.
- Slack ingress should set `SLACK_SIGNING_SECRET` or
  `VIBE_BRIDGE_SLACK_SIGNING_SECRET`.
- LINE ingress should set `LINE_CHANNEL_SECRET` or
  `VIBE_BRIDGE_LINE_CHANNEL_SECRET`.
- SQS ingress should use least-privilege AWS credentials scoped to the queue.
- WebSocket ingress should use `wss://` and set `VIBE_BRIDGE_WS_TOKEN` when the
  upstream supports bearer authentication.
- Local tunnels such as ngrok or Cloudflare Tunnel should point only at the
  ingress process, not at the runner or unrelated local services.

## Known Risk Areas

- `aiBackend=command` and `kind=cli` can execute local processes. Use strict
  command IDs and avoid accepting raw commands from untrusted sources.
- OpenAI-compatible, Cursor, Claude Code, and local LLM backends can receive
  repository context and prompts. Configure them as data processors for the
  environment where they run.
- Callback URLs in job params can send data to external systems. Treat
  callbacks as egress and restrict them at the source when possible.
- Inline artifacts and logs can contain sensitive text if a local tool prints
  secrets. Review output before forwarding it to public or third-party systems.

## Threat Model

The maintained threat model is in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

