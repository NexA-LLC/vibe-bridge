import type { JobResult, JobSpec } from "@vibe-bridge/shared";

export interface RunnerConfig {
  apiBaseUrl: string;
  token: string;
  pollIntervalSec: number;
  leaseTtlSec: number;
}

export async function executeJob(_job: JobSpec): Promise<JobResult> {
  throw new Error("executeJob not implemented");
}
