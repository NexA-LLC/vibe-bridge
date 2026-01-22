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
- `VIBE_BRIDGE_RUNNER_TENANT_ID` (optional; only lease jobs for this tenant)
- `VIBE_BRIDGE_RUNNER_KINDS` (optional; comma-separated kinds filter, e.g. `cli,mcp,vibeKanban,vibeKanban.mcp`)
- `VIBE_BRIDGE_RUNNER_PHASES` (optional; comma-separated phases filter, e.g. `plan,execute`)
- `VIBE_BRIDGE_POLL_INTERVAL_SEC` (default 5)
- `VIBE_BRIDGE_LEASE_TTL_SEC` (default 300)
- `VIBE_BRIDGE_PLAN_COMMAND` (optional default plan command)
- `VIBE_BRIDGE_EXECUTE_COMMAND` (optional default execute command)
- `VIBE_BRIDGE_VIBE_KANBAN_BASE_URL` (optional, e.g. `http://127.0.0.1:3001`)
- `VIBE_BRIDGE_LLM_BASE_URL` / `VIBE_BRIDGE_LLM_API_KEY` / `VIBE_BRIDGE_LLM_MODEL` (optional; OpenAI-compatible `/chat/completions`)
- `VIBE_BRIDGE_LLM_TIMEOUT_MS` (default 20000)
- `FLOWLOG_VIBE_BRIDGE_QUEUE_BASE_URL` (optional; enables Flowlog queue polling)
- `FLOWLOG_SYNC_TOKEN` (required when Flowlog queue is enabled)

Plan flow:
- Job phase `plan` runs `commands.plan` (or env fallback) as a shell command.
- If `planOutputPath` is provided, the runner reads that file as plan text.
- Plan output is sent back via `artifactsInline.plan`.
- Prompt template lives at `prompts/plan.md` (use it in your plan command).

Vibe Kanban flow (job kind `vibeKanban` / `vibeKanban.mcp`):
- The runner talks to the local Vibe Kanban backend (`VIBE_BRIDGE_VIBE_KANBAN_BASE_URL`, or temp port file fallback).
- Set `params.tool` to call one of:
  - `list_projects`
  - `create_task` (needs `project_id` + `title`, optional `description`)
  - `start_workspace_session` (alias `start_task_attempt`; starts an attempt/workspace, which is when Vibe Kanban creates the git worktree)

Callbacks (optional):
- If the job includes `params.callback = {url, headers?, timeoutMs?}`, the runner POSTs a completion payload after the control plane is updated.
- Payload: `{jobId, tenantId, kind, phase, projectId, result, runnerId}`

Flowlog moyatto hook (optional):
- When the job includes `params.flowlog.userEmail`, the runner generates 1-3 “moyatto” candidates after `create_task`.
- Candidates are stored in `result.artifactsInline.moyattoCandidates` (JSON string). A Flowlog-side callback handler can persist them as manual items.
