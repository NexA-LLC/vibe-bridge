# Runner

The runner lives in customer environments and pulls jobs from the control plane. It executes jobs
through adapters (MCP, Vibe Kanban, CLI) and reports status, logs, and artifacts.

Key traits:
- Outbound-only HTTPS
- Long-poll with backoff
- Lease + heartbeat for safe retries

Environment:
- `VIBE_BRIDGE_API_BASE` (required)
- `VIBE_BRIDGE_API_TOKEN` (required)
- `VIBE_BRIDGE_WORKSPACE_ROOT` (required)
- `VIBE_BRIDGE_RUNNER_ID` (optional)
- `VIBE_BRIDGE_POLL_INTERVAL_SEC` (default 5)
- `VIBE_BRIDGE_LEASE_TTL_SEC` (default 300)
- `VIBE_BRIDGE_PLAN_COMMAND` (optional default plan command)
- `VIBE_BRIDGE_EXECUTE_COMMAND` (optional default execute command)

Plan flow:
- Job phase `plan` runs `commands.plan` (or env fallback) as a shell command.
- If `planOutputPath` is provided, the runner reads that file as plan text.
- Plan output is sent back via `artifactsInline.plan`.
- Prompt template lives at `prompts/plan.md` (use it in your plan command).
