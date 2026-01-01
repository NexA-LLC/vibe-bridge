import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { JobEvent, JobResult, JobSpec } from "@vibe-bridge/shared";

const MAX_EVENT_MESSAGE = 1800;

export interface RunnerConfig {
  apiBaseUrl: string;
  token: string;
  pollIntervalSec: number;
  leaseTtlSec: number;
  workspaceRoot: string;
  runnerId?: string;
  defaultPlanCommand?: string;
  defaultExecuteCommand?: string;
}

const nowIso = () => new Date().toISOString();

const trimMessage = (value: string) =>
  value.length > MAX_EVENT_MESSAGE ? `${value.slice(0, MAX_EVENT_MESSAGE)}...` : value;

const postJson = async (baseUrl: string, token: string, pathName: string, payload: unknown) => {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed ${response.status}: ${body}`);
  }
  return response.json().catch(() => null);
};

const getJson = async (baseUrl: string, token: string, pathName: string) => {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed ${response.status}: ${body}`);
  }
  return response.json();
};

const sanitizeName = (value: string) => value.replace(/[^a-zA-Z0-9-_]/g, "-");

const resolveRepoDir = (workspaceRoot: string, repoUrl: string, tenantId: string, projectId?: string) => {
  const cleanTenant = sanitizeName(tenantId || "default");
  const cleanProject = sanitizeName(projectId || "default");
  const name = repoUrl.split("/").pop() || "repo";
  const cleanName = sanitizeName(name.replace(/\.git$/i, "")) || "repo";
  return path.join(workspaceRoot, cleanTenant, cleanProject, cleanName);
};

const runShell = async (
  command: string,
  cwd: string,
  onChunk?: (chunk: string) => Promise<void>,
) => {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const pushChunk = (data: Buffer, append: (text: string) => void) => {
      const text = data.toString();
      append(text);
      if (onChunk) void onChunk(text).catch(() => {});
    };
    child.stdout.on("data", (data) => pushChunk(data, (text) => (stdout += text)));
    child.stderr.on("data", (data) => pushChunk(data, (text) => (stderr += text)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
};

const ensureRepo = async (job: JobSpec, workspaceRoot: string) => {
  if (!job.repo?.url) return { repoDir: workspaceRoot, checkoutDir: workspaceRoot };
  const repoDir = resolveRepoDir(workspaceRoot, job.repo.url, job.tenantId, job.projectId);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  const gitDir = path.join(repoDir, ".git");
  const ref = job.repo.ref || "main";
  const hasRepo = await fs
    .stat(gitDir)
    .then(() => true)
    .catch(() => false);
  if (!hasRepo) {
    await runShell(`git clone --depth=1 ${job.repo.url} ${repoDir}`, workspaceRoot);
  } else {
    await runShell(`git -C ${repoDir} fetch --all --prune`, workspaceRoot);
  }
  await runShell(`git -C ${repoDir} checkout ${ref}`, workspaceRoot);
  const checkoutDir = job.repo.subdir ? path.join(repoDir, job.repo.subdir) : repoDir;
  return { repoDir, checkoutDir };
};

const sendEvent = async (config: RunnerConfig, job: JobSpec, kind: JobEvent["kind"], message: string) => {
  const event: JobEvent = {
    id: randomUUID(),
    jobId: job.id,
    kind,
    message: trimMessage(message),
    createdAt: nowIso(),
  };
  await postJson(config.apiBaseUrl, config.token, `/jobs/${job.id}/events`, { event });
};

const completeJob = async (config: RunnerConfig, result: JobResult) => {
  await postJson(config.apiBaseUrl, config.token, `/jobs/${result.jobId}/complete`, { result });
};

const resolveCommand = (job: JobSpec, phase: "plan" | "execute", config: RunnerConfig) => {
  const params = job.params || {};
  const paramCommand =
    typeof params[`${phase}Command`] === "string" ? String(params[`${phase}Command`]) : undefined;
  if (phase === "plan") {
    return job.commands?.plan || paramCommand || config.defaultPlanCommand;
  }
  return job.commands?.execute || paramCommand || config.defaultExecuteCommand;
};

export const executeJob = async (job: JobSpec, config: RunnerConfig): Promise<JobResult> => {
  const phase = job.phase || "execute";
  const command = resolveCommand(job, phase, config);
  if (!command) {
    const result: JobResult = {
      jobId: job.id,
      status: "failed",
      finishedAt: nowIso(),
      errorMessage: `Missing ${phase} command`,
    };
    await completeJob(config, result);
    return result;
  }

  const { checkoutDir } = await ensureRepo(job, config.workspaceRoot);
  await sendEvent(config, job, "status", `Started ${phase}`);

  const outputChunks: string[] = [];
  const onChunk = async (chunk: string) => {
    outputChunks.push(chunk);
    await sendEvent(config, job, "log", chunk);
  };
  const { code, stdout, stderr } = await runShell(command, checkoutDir, onChunk);

  let planText = "";
  if (phase === "plan") {
    if (job.planOutputPath) {
      const planPath = path.join(checkoutDir, job.planOutputPath);
      planText = await fs.readFile(planPath, "utf8").catch(() => "");
    }
    if (!planText) planText = stdout || outputChunks.join("");
  }

  const status: JobResult["status"] = code === 0 ? "completed" : "failed";
  const result: JobResult = {
    jobId: job.id,
    status,
    finishedAt: nowIso(),
    artifactsInline: phase === "plan" && planText ? { plan: planText } : undefined,
    errorMessage: status === "failed" ? stderr || `Command failed with code ${code}` : undefined,
  };
  await sendEvent(config, job, "status", `${phase} finished (${status})`);
  await completeJob(config, result);
  return result;
};

export const runOnce = async (config: RunnerConfig) => {
  const query = new URLSearchParams({
    leaseTtlSec: String(config.leaseTtlSec || 300),
    waitSec: "0",
  });
  if (config.runnerId) query.set("runnerId", config.runnerId);
  const payload = await getJson(config.apiBaseUrl, config.token, `/jobs/next?${query.toString()}`);
  if (!payload || !payload.job) return false;
  await executeJob(payload.job as JobSpec, config);
  return true;
};

export const runLoop = async (config: RunnerConfig) => {
  while (true) {
    try {
      const handled = await runOnce(config);
      if (!handled) await delay((config.pollIntervalSec || 5) * 1000);
    } catch (error) {
      console.error("[vibe-bridge] runner error", error);
      await delay((config.pollIntervalSec || 5) * 1000);
    }
  }
};

const loadEnvConfig = (): RunnerConfig => {
  const apiBaseUrl = (process.env.VIBE_BRIDGE_API_BASE || "").trim();
  const token = (process.env.VIBE_BRIDGE_API_TOKEN || "").trim();
  const workspaceRoot = (process.env.VIBE_BRIDGE_WORKSPACE_ROOT || "").trim();
  if (!apiBaseUrl || !token || !workspaceRoot) {
    throw new Error("Missing VIBE_BRIDGE_API_BASE / VIBE_BRIDGE_API_TOKEN / VIBE_BRIDGE_WORKSPACE_ROOT");
  }
  return {
    apiBaseUrl,
    token,
    workspaceRoot,
    pollIntervalSec: Number(process.env.VIBE_BRIDGE_POLL_INTERVAL_SEC || "5"),
    leaseTtlSec: Number(process.env.VIBE_BRIDGE_LEASE_TTL_SEC || "300"),
    runnerId: process.env.VIBE_BRIDGE_RUNNER_ID || undefined,
    defaultPlanCommand: process.env.VIBE_BRIDGE_PLAN_COMMAND || undefined,
    defaultExecuteCommand: process.env.VIBE_BRIDGE_EXECUTE_COMMAND || undefined,
  };
};

const main = async () => {
  const config = loadEnvConfig();
  await runLoop(config);
};

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url &&
  process.env.VIBE_BRIDGE_DISABLE_AUTO_RUN !== "1";

if (isDirectRun) {
  main().catch((error) => {
    console.error("[vibe-bridge] runner failed", error);
    process.exit(1);
  });
}
