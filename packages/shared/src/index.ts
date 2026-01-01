export type JobKind = "cli" | "mcp" | "vibeKanban" | "brain";
export type JobState = "queued" | "leased" | "running" | "completed" | "failed" | "canceled";

export interface JobSpec {
  id: string;
  tenantId: string;
  kind: JobKind;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutSec?: number;
  requestedAt: string;
}

export interface JobLease {
  jobId: string;
  leaseUntil: string;
  attempt: number;
}

export interface JobResult {
  jobId: string;
  status: "completed" | "failed" | "canceled";
  finishedAt: string;
  artifacts?: Record<string, string>;
  logsRef?: string;
  errorCode?: string;
  errorMessage?: string;
}
