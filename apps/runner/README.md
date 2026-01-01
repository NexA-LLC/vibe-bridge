# Runner

The runner lives in customer environments and pulls jobs from the control plane. It executes jobs
through adapters (MCP, Vibe Kanban, CLI) and reports status, logs, and artifacts.

Key traits:
- Outbound-only HTTPS
- Long-poll with backoff
- Lease + heartbeat for safe retries
