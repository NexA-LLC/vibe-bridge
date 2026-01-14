import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { JobEvent, JobResult, JobSpec } from "@vibe-bridge/shared";

const MAX_EVENT_MESSAGE = 1800;

type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
type LlmConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };
type MoyattoCandidate = { text: string; reason: string };

export interface RunnerConfig {
  apiBaseUrl: string;
  token: string;
  pollIntervalSec: number;
  leaseTtlSec: number;
  workspaceRoot: string;
  runnerId?: string;
  defaultPlanCommand?: string;
  defaultExecuteCommand?: string;
  filterTenantId?: string;
  filterKinds?: string;
  filterPhases?: string;
}

const nowIso = () => new Date().toISOString();

const trimMessage = (value: string) =>
  value.length > MAX_EVENT_MESSAGE ? `${value.slice(0, MAX_EVENT_MESSAGE)}...` : value;

const resolveEnv = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const getNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

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

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const normalizeLlmBaseUrl = (value: string) => value.replace(/\/$/, "");

const getLlmConfig = (): LlmConfig => {
  const baseUrl =
    resolveEnv("VIBE_BRIDGE_LLM_BASE_URL", "FLOWLOG_LLM_BASE_URL", "NEXA_LLM_BASE_URL") ||
    "http://127.0.0.1:1234/v1";
  const apiKey = resolveEnv("VIBE_BRIDGE_LLM_API_KEY", "FLOWLOG_LLM_API_KEY", "NEXA_LLM_API_KEY") || "sk-local";
  const model = resolveEnv("VIBE_BRIDGE_LLM_MODEL", "FLOWLOG_LLM_MODEL", "NEXA_LLM_MODEL") || "auto";
  const timeoutMs =
    getNumber(resolveEnv("VIBE_BRIDGE_LLM_TIMEOUT_MS", "FLOWLOG_LLM_TIMEOUT_MS")) ||
    20000;
  return { baseUrl: normalizeLlmBaseUrl(baseUrl), apiKey, model, timeoutMs };
};

const requestChatCompletion = async (messages: LlmMessage[], options: { temperature?: number } = {}) => {
  const config = getLlmConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.2,
      }),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed ${response.status}: ${rawText}`);
    }
    const raw = rawText ? (JSON.parse(rawText) as unknown) : null;
    let content = "";
    const rawRecord = asRecord(raw);
    const choices = rawRecord?.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = asRecord(choices[0]);
      const message = firstChoice ? asRecord(firstChoice.message) : null;
      const value = message ? getString(message.content) : undefined;
      if (value) content = value;
    }
    if (!content.trim()) throw new Error("Empty LLM response");
    return content;
  } finally {
    clearTimeout(timeout);
  }
};

const truncate = (value: string, maxLen: number) => {
  const text = value.trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const stripCodeFences = (value: string) => {
  let text = value.trim();
  if (!text.startsWith("```")) return text;
  text = text.replace(/^```(?:json)?\s*/i, "");
  text = text.replace(/```\s*$/i, "");
  return text.trim();
};

const extractJsonBlock = (value: string): unknown => {
  const text = value.trim();
  const pairs = [
    ["[", "]"],
    ["{", "}"],
  ];
  for (const [startChar, endChar] of pairs) {
    const start = text.indexOf(startChar);
    const end = text.lastIndexOf(endChar);
    if (start === -1 || end === -1 || end <= start) continue;
    const snippet = text.slice(start, end + 1);
    const parsed = safeJsonParse(snippet);
    if (parsed !== null) return parsed;
  }
  return null;
};

const parseCandidateLines = (value: string): MoyattoCandidate[] => {
  const results: MoyattoCandidate[] = [];
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cleaned = line.replace(/^[\-*\d\.\)\(]+\s*/, "");
    let textPart = "";
    let reasonPart = "";
    if (cleaned.includes(" - ")) [textPart, reasonPart] = cleaned.split(" - ", 2);
    else if (cleaned.includes(" — ")) [textPart, reasonPart] = cleaned.split(" — ", 2);
    else if (cleaned.includes(":")) [textPart, reasonPart] = cleaned.split(":", 2);
    else continue;
    const text = textPart.trim();
    const reason = reasonPart.trim();
    if (!text || !reason) continue;
    results.push({ text, reason });
    if (results.length >= 3) break;
  }
  return results;
};

const parseCandidates = (content: string): MoyattoCandidate[] => {
  const cleaned = stripCodeFences(content);
  const parsed =
    cleaned.startsWith("[") || cleaned.startsWith("{") ? safeJsonParse(cleaned) : extractJsonBlock(cleaned);

  const takeFromItems = (items: unknown[]): MoyattoCandidate[] => {
    const out: MoyattoCandidate[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const text = String(obj.text ?? obj.task ?? obj.title ?? "").trim();
      const reason = String(obj.reason ?? obj.rationale ?? obj.why ?? "").trim();
      if (!text || !reason) continue;
      out.push({ text, reason });
      if (out.length >= 3) break;
    }
    return out;
  };

  if (Array.isArray(parsed)) {
    const out = takeFromItems(parsed);
    if (out.length > 0) return out;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ["items", "candidates", "suggestions", "tasks"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        const out = takeFromItems(value);
        if (out.length > 0) return out;
      }
    }
  }

  return parseCandidateLines(cleaned);
};

const resolveFlowlogConfig = () => {
  const baseUrl = resolveEnv("VIBE_BRIDGE_FLOWLOG_BASE_URL", "FLOWLOG_BASE_URL") || "";
  const token = resolveEnv("VIBE_BRIDGE_FLOWLOG_SYNC_TOKEN", "FLOWLOG_SYNC_TOKEN") || "";
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
  };
};

const postMoyattoManual = async (config: { baseUrl: string; token: string }, payload: Record<string, unknown>) => {
  const res = await fetch(`${config.baseUrl}/api/integrations/moyatto/manual`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": "vibe-bridge-runner/0.1",
    },
    body: JSON.stringify(payload),
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Flowlog moyatto failed ${res.status}: ${rawText}`);
  }
};

const buildMoyattoMessages = (title: string, description: string | null, taskId: string): LlmMessage[] => {
  const system = [
    "You create 1-3 follow-up task candidates after a task is created in Vibe Kanban.",
    "Return a JSON array of objects with keys text and reason.",
    "text: short, actionable, one line.",
    "reason: short and specific.",
    "Avoid repeating the original task title.",
    "Do not include markdown or code fences.",
  ].join(" ");
  const user = [
    `Task title: ${title}`,
    `Description: ${description && description.trim() ? description.trim() : "(none)"}`,
    `Vibe Kanban task id: ${taskId}`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
};

const maybeEnqueueMoyattoAfterCreateTask = async (
  runnerConfig: RunnerConfig,
  job: JobSpec,
  input: { title: string; description: string | null; taskId: string },
): Promise<{ status: "skipped" | "ok" | "empty"; posted: number }> => {
  const params = asRecord(job.params) ?? {};
  const flowlog = asRecord(params.flowlog) ?? null;
  const userEmail = flowlog ? getString(flowlog.userEmail) : undefined;
  if (!userEmail) return { status: "skipped", posted: 0 };

  const flowlogCfg = resolveFlowlogConfig();
  if (!flowlogCfg.baseUrl || !flowlogCfg.token) {
    await sendEvent(runnerConfig, job, "status", "Moyatto skipped: missing Flowlog config");
    return { status: "skipped", posted: 0 };
  }

  const title = input.title.trim();
  if (!title) return { status: "skipped", posted: 0 };
  await sendEvent(runnerConfig, job, "status", "Moyatto: generating candidates");

  const messages = buildMoyattoMessages(title, input.description, input.taskId);
  const content = await requestChatCompletion(messages, { temperature: 0.2 });
  const candidates = parseCandidates(content);
  if (candidates.length === 0) {
    await sendEvent(runnerConfig, job, "status", "Moyatto: no candidates");
    return { status: "empty", posted: 0 };
  }

  const tenantId = job.tenantId;
  const seen = new Set<string>();
  let posted = 0;
  for (const item of candidates) {
    const text = truncate(item.text, 200);
    const reason = truncate(item.reason, 200);
    if (!text || !reason) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = [`reason:${reason}`, `vk_job:${job.id}`, `vk_task:${input.taskId}`];
    await postMoyattoManual(flowlogCfg, {
      text,
      source: "vibe_kanban",
      tags,
      externalRef: `vibe-kanban:${job.id}`,
      tenantId,
      userEmail,
    });
    posted += 1;
  }
  await sendEvent(runnerConfig, job, "status", `Moyatto: enqueued ${posted}`);
  return { status: "ok", posted };
};

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
  const jobKind = String(job.kind || "");
  if (jobKind === "vibeKanban" || jobKind.startsWith("vibeKanban.")) {
    return executeVibeKanbanJob(job, config);
  }

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

type VkApiResponseEnvelope<T> = {
  success: boolean;
  data: T | null;
  error_data: unknown | null;
  message: string | null;
};

const readPortFile = async (appName: string): Promise<number> => {
  const dir = path.join(os.tmpdir(), appName);
  const filePath = path.join(dir, `${appName}.port`);
  const raw = await fs.readFile(filePath, "utf8");
  const port = Number(raw.trim());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid port file value: ${filePath}`);
  }
  return port;
};

const resolveVibeKanbanBaseUrl = async (job: JobSpec, config: RunnerConfig): Promise<string> => {
  const params = asRecord(job.params) ?? {};
  const explicit =
    getString(params.vibeBackendUrl) ||
    getString(params.vibeKanbanBaseUrl) ||
    getString(params.vkBaseUrl) ||
    getString(process.env.VIBE_BRIDGE_VIBE_KANBAN_BASE_URL) ||
    getString(process.env.VIBE_BACKEND_URL);
  if (explicit) return normalizeBaseUrl(explicit);

  const host = getString(process.env.HOST) || "127.0.0.1";
  const portEnv = getString(process.env.BACKEND_PORT) || getString(process.env.PORT);
  if (portEnv) return normalizeBaseUrl(`http://${host}:${portEnv}`);

  const port = await readPortFile("vibe-kanban");
  return normalizeBaseUrl(`http://${host}:${port}`);
};

const vkFetch = async <T>(
  baseUrl: string,
  pathName: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Vibe Kanban request failed ${response.status}: ${rawText}`);
  }

  const parsed = rawText ? (JSON.parse(rawText) as unknown) : null;
  const envelope = asRecord(parsed) as VkApiResponseEnvelope<T> | null;
  if (envelope && typeof envelope.success === "boolean" && "data" in envelope) {
    if (!envelope.success) {
      throw new Error(`Vibe Kanban error: ${envelope.message || "unknown error"}`);
    }
    if (envelope.data === null) {
      throw new Error(`Vibe Kanban empty response: ${pathName}`);
    }
    return envelope.data;
  }

  return parsed as T;
};

const normalizeExecutor = (value: string): string => value.trim().replace(/-/g, "_").toUpperCase();

const executeVibeKanbanJob = async (job: JobSpec, config: RunnerConfig): Promise<JobResult> => {
  const params = asRecord(job.params) ?? {};
  const toolHint = getString(params.tool) || getString(params.action) || getString(params.kind);
  const toolInput = asRecord(params.input) ?? asRecord(params.request) ?? params;
  const tool =
    toolHint ||
    ((getString(toolInput.task_id) || getString(toolInput.taskId)) && getString(toolInput.executor)
      ? "start_workspace_session"
      : "create_task");
  try {
    const baseUrl = await resolveVibeKanbanBaseUrl(job, config);
    await sendEvent(config, job, "status", `Vibe Kanban: ${tool}`);

    if (tool === "list_projects") {
      const projects = await vkFetch<unknown[]>(baseUrl, "/api/projects");
      const result: JobResult = {
        jobId: job.id,
        status: "completed",
        finishedAt: nowIso(),
        artifactsInline: { projects: JSON.stringify(projects) },
      };
      await completeJob(config, result);
      return result;
    }

    if (tool === "create_task") {
      const projectId = getString(toolInput.project_id) || getString(toolInput.projectId) || job.projectId;
      const title = getString(toolInput.title);
      const description = getString(toolInput.description) || null;
      if (!projectId) throw new Error("Missing Vibe Kanban project_id (use params.project_id or job.projectId)");
      if (!title) throw new Error("Missing Vibe Kanban task title (use params.title)");

      const task = await vkFetch<{ id: string }>(baseUrl, "/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          title,
          description,
          status: null,
          parent_workspace_id: null,
          image_ids: null,
          shared_task_id: null,
        }),
      });

      await sendEvent(config, job, "status", `Vibe Kanban: created task ${task.id}`);
      let moyattoStatus: string | undefined;
      let moyattoPosted: number | undefined;
      let moyattoError: string | undefined;
      try {
        const outcome = await maybeEnqueueMoyattoAfterCreateTask(config, job, { title, description, taskId: task.id });
        moyattoStatus = outcome.status;
        moyattoPosted = outcome.posted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        moyattoStatus = "error";
        moyattoError = truncate(message, 240);
        try {
          await sendEvent(config, job, "status", `Moyatto failed: ${message}`);
        } catch {
          // ignore
        }
      }
      const artifactsInline: Record<string, string> = { taskId: task.id };
      if (moyattoStatus) artifactsInline.moyattoStatus = moyattoStatus;
      if (typeof moyattoPosted === "number") artifactsInline.moyattoPosted = String(moyattoPosted);
      if (moyattoError) artifactsInline.moyattoError = moyattoError;
      const result: JobResult = {
        jobId: job.id,
        status: "completed",
        finishedAt: nowIso(),
        artifactsInline,
      };
      await completeJob(config, result);
      return result;
    }

    if (tool === "start_workspace_session" || tool === "start_task_attempt") {
      const taskId = getString(toolInput.task_id) || getString(toolInput.taskId);
      const executorRaw = getString(toolInput.executor);
      const variant = getString(toolInput.variant) || null;
      if (!taskId) throw new Error("Missing Vibe Kanban task_id (use params.task_id)");
      if (!executorRaw) throw new Error("Missing executor (use params.executor)");

      const reposRaw = Array.isArray(toolInput.repos) ? toolInput.repos : null;
      const repos: Array<{ repo_id: string; target_branch: string }> = [];
      if (reposRaw) {
        for (const entry of reposRaw) {
          if (typeof entry === "string") {
            const baseBranch = getString(toolInput.base_branch) || getString(toolInput.baseBranch) || "main";
            repos.push({ repo_id: entry, target_branch: baseBranch });
            continue;
          }
          const obj = asRecord(entry);
          if (!obj) continue;
          const repoId = getString(obj.repo_id) || getString(obj.repoId);
          const baseBranch =
            getString(obj.target_branch) ||
            getString(obj.targetBranch) ||
            getString(obj.base_branch) ||
            getString(obj.baseBranch) ||
            getString(toolInput.base_branch) ||
            getString(toolInput.baseBranch) ||
            "main";
          if (!repoId) continue;
          repos.push({ repo_id: repoId, target_branch: baseBranch });
        }
      }

      if (repos.length === 0) {
        const projectId = getString(toolInput.project_id) || getString(toolInput.projectId) || job.projectId;
        if (!projectId) {
          throw new Error("Missing repos. Provide params.repos or params.project_id (+ base_branch).");
        }
        const baseBranch = getString(toolInput.base_branch) || getString(toolInput.baseBranch) || "main";
        const projectRepos = await vkFetch<Array<{ id: string }>>(baseUrl, `/api/projects/${projectId}/repositories`);
        for (const repo of projectRepos) {
          if (repo && typeof repo.id === "string") {
            repos.push({ repo_id: repo.id, target_branch: baseBranch });
          }
        }
      }

      if (repos.length === 0) {
        throw new Error("No repositories resolved for task attempt");
      }

      const workspace = await vkFetch<{ id: string; branch: string }>(baseUrl, "/api/task-attempts", {
        method: "POST",
        body: JSON.stringify({
          task_id: taskId,
          executor_profile_id: { executor: normalizeExecutor(executorRaw), variant },
          repos,
        }),
      });

      await sendEvent(config, job, "status", `Vibe Kanban: started workspace ${workspace.id} (${workspace.branch})`);
      const result: JobResult = {
        jobId: job.id,
        status: "completed",
        finishedAt: nowIso(),
        artifactsInline: { workspaceId: workspace.id, branch: workspace.branch },
      };
      await completeJob(config, result);
      return result;
    }

    throw new Error(`Unknown Vibe Kanban tool: ${tool}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await sendEvent(config, job, "status", `Vibe Kanban failed: ${message}`);
    } catch {
      // ignore
    }
    const result: JobResult = {
      jobId: job.id,
      status: "failed",
      finishedAt: nowIso(),
      errorMessage: message,
    };
    await completeJob(config, result);
    return result;
  }
};

export const runOnce = async (config: RunnerConfig) => {
  const query = new URLSearchParams({
    leaseTtlSec: String(config.leaseTtlSec || 300),
    waitSec: "0",
  });
  if (config.runnerId) query.set("runnerId", config.runnerId);
  if (config.filterTenantId) query.set("tenantId", config.filterTenantId);
  if (config.filterKinds) query.set("kinds", config.filterKinds);
  if (config.filterPhases) query.set("phases", config.filterPhases);
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
    filterTenantId: process.env.VIBE_BRIDGE_RUNNER_TENANT_ID || undefined,
    filterKinds: process.env.VIBE_BRIDGE_RUNNER_KINDS || undefined,
    filterPhases: process.env.VIBE_BRIDGE_RUNNER_PHASES || undefined,
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
