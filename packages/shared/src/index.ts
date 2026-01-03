export type JobKind = "cli" | "mcp" | "vibeKanban" | "vibeKanban.mcp" | "brain";
export type JobState = "queued" | "leased" | "running" | "completed" | "failed" | "canceled";
export type JobPhase = "plan" | "execute";

export type JobEventKind = "log" | "status" | "question" | "note";

export interface RepoSpec {
  url: string;
  ref?: string;
  subdir?: string;
}

export interface JobCommandSpec {
  plan?: string;
  execute?: string;
}

export interface JobSpec {
  id: string;
  tenantId: string;
  kind: JobKind;
  phase?: JobPhase;
  projectId?: string;
  repo?: RepoSpec;
  commands?: JobCommandSpec;
  planOutputPath?: string;
  context?: string;
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
  artifactsInline?: Record<string, string>;
  logsRef?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  kind: JobEventKind;
  message: string;
  createdAt: string;
  sequence?: number;
  data?: Record<string, unknown>;
}
