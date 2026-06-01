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
type LlmConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; pathName: string };
type MoyattoCandidate = { text: string; reason: string };
type AiBackend =
  | "codex-cli"
  | "codex-app-server"
  | "cursor-cli"
  | "cursor-api"
  | "claude-code"
  | "local-llm"
  | "openai-compatible"
  | "command";

type CommandSpec = {
  cwd?: string;
  exec: string[];
  args?: string[];
  allowArgs?: boolean;
  env?: Record<string, string>;
};

type CommandRegistry = {
  commands: Record<string, CommandSpec>;
  sources: string[];
};

type ResolvedCommand =
  | { kind: "shell"; command: string }
  | { kind: "exec"; exec: string[]; cwd?: string; env?: Record<string, string> };

export interface RunnerConfig {
  apiBaseUrl: string;
  token: string;
  pollIntervalSec: number;
  leaseTtlSec: number;
  workspaceRoot: string;
  runnerId?: string;
  defaultPlanCommand?: string;
  defaultExecuteCommand?: string;
  flowlogQueueBaseUrl?: string;
  flowlogQueueToken?: string;
  flowalignQueueBaseUrl?: string;
  flowalignQueueToken?: string;
  filterTenantId?: string;
  filterKinds?: string;
  filterPhases?: string;
  defaultAiBackend?: string;
  codexBin?: string;
  codexAppServerRemote?: string;
  cursorBin?: string;
  cursorCommand?: string;
  claudeBin?: string;
  aiCommand?: string;
  commandsRegistry?: CommandRegistry;
  commandsStrict?: boolean;
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

const getStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
};

const coerceStringArgs = (value: unknown): string[] | undefined => {
  const list = getStringArray(value);
  if (list) return list;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  return undefined;
};

const expandHome = (value: string): string => {
  const home = os.homedir();
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value.replaceAll("${HOME}", home).replaceAll("$HOME", home);
};

const resolvePathFrom = (baseDir: string, value: string): string => {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
};

const stripInlineComment = (line: string): string => {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === `"` && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      break;
    }
    out += ch;
  }
  return out;
};

const splitFlowItems = (raw: string): string[] => {
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === `"` && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
};

const parseScalar = (raw: string): unknown => {
  if (!raw) return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith(`"`) && raw.endsWith(`"`)) || (raw.startsWith("'") && raw.endsWith("'"))) {
    const body = raw.slice(1, -1);
    if (raw.startsWith(`"`)) {
      try {
        return JSON.parse(`"${body.replace(/"/g, '\\"')}"`);
      } catch {
        return body;
      }
    }
    return body.replace(/''/g, "'");
  }
  return raw;
};

const parseValue = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner).map((entry) => parseScalar(entry));
  }
  return parseScalar(trimmed);
};

const parseSimpleYaml = (raw: string): unknown => {
  type Ctx = { indent: number; value: unknown; pending?: boolean; parent?: Record<string, unknown>; key?: string };
  const root: Record<string, unknown> = {};
  const stack: Ctx[] = [{ indent: -1, value: root }];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripInlineComment(lines[index]);
    if (!rawLine.trim()) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const text = rawLine.slice(indent).trimEnd();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const ctx = stack[stack.length - 1];
    if (ctx.pending) {
      if (text.startsWith("- ")) {
        const list: unknown[] = [];
        if (ctx.parent && ctx.key) ctx.parent[ctx.key] = list;
        ctx.value = list;
      }
      ctx.pending = false;
    }
    if (text.startsWith("- ")) {
      if (!Array.isArray(ctx.value)) {
        throw new Error(`Invalid YAML: list item without list at line ${index + 1}`);
      }
      const itemText = text.slice(2).trim();
      ctx.value.push(parseValue(itemText));
      continue;
    }
    const idx = text.indexOf(":");
    if (idx === -1) {
      throw new Error(`Invalid YAML: missing ':' at line ${index + 1}`);
    }
    const key = text.slice(0, idx).trim();
    const valueText = text.slice(idx + 1).trim();
    if (!key) {
      throw new Error(`Invalid YAML: empty key at line ${index + 1}`);
    }
    if (valueText.length === 0) {
      const obj: Record<string, unknown> = {};
      if (!asRecord(ctx.value)) {
        throw new Error(`Invalid YAML: cannot assign key at line ${index + 1}`);
      }
      (ctx.value as Record<string, unknown>)[key] = obj;
      stack.push({ indent, value: obj, pending: true, parent: ctx.value as Record<string, unknown>, key });
      continue;
    }
    const value = parseValue(valueText);
    if (!asRecord(ctx.value)) {
      throw new Error(`Invalid YAML: cannot assign key at line ${index + 1}`);
    }
    (ctx.value as Record<string, unknown>)[key] = value;
    if (asRecord(value) || Array.isArray(value)) {
      stack.push({ indent, value });
    }
  }
  return root;
};

const coerceStringArray = (value: unknown): string[] | undefined => {
  const list = getStringArray(value);
  if (list) return list;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  return undefined;
};

const coerceEnvMap = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .map(([key, entry]) => {
      if (!key.trim()) return null;
      if (typeof entry === "string") return [key, entry];
      if (typeof entry === "number" || typeof entry === "boolean") return [key, String(entry)];
      return null;
    })
    .filter(Boolean) as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const loadCommandsFile = async (filePath: string): Promise<CommandRegistry> => {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : parseSimpleYaml(raw);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`Invalid commands file (root must be a mapping): ${filePath}`);
  }
  const commandsRecord = asRecord(record.commands);
  if (!commandsRecord) {
    throw new Error(`Invalid commands file (missing commands): ${filePath}`);
  }
  const baseDir = path.dirname(filePath);
  const commands: Record<string, CommandSpec> = {};
  for (const [id, entry] of Object.entries(commandsRecord)) {
    const spec = asRecord(entry);
    if (!spec) {
      throw new Error(`Invalid command spec for "${id}" in ${filePath}`);
    }
    const exec = coerceStringArray(spec.exec);
    if (!exec || exec.length === 0) {
      throw new Error(`Command "${id}" missing exec in ${filePath}`);
    }
    const cwdRaw = getString(spec.cwd);
    const cwd = cwdRaw ? resolvePathFrom(baseDir, cwdRaw) : undefined;
    const args = coerceStringArray(spec.args);
    const env = coerceEnvMap(spec.env);
    const allowArgs = Boolean(spec.allowArgs);
    commands[id] = {
      cwd,
      exec,
      args,
      allowArgs,
      env,
    };
  }
  return { commands, sources: [filePath] };
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code === "ENOENT") return false;
    throw error;
  }
};

const findFirstExisting = async (paths: string[]): Promise<string | undefined> => {
  for (const candidate of paths) {
    const resolved = resolvePathFrom(process.cwd(), candidate);
    if (await fileExists(resolved)) return resolved;
  }
  return undefined;
};

const resolveCommandsRegistry = async (): Promise<CommandRegistry | undefined> => {
  const baseEnv = resolveEnv("VIBE_BRIDGE_COMMANDS_FILE");
  const localEnv = resolveEnv("VIBE_BRIDGE_COMMANDS_LOCAL_FILE");
  const candidates = [
    path.join(process.cwd(), "config", "commands.yml"),
    path.join(process.cwd(), "commands.yml"),
    path.join(os.homedir(), ".config", "vibe-bridge", "commands.yml"),
  ].filter(Boolean) as string[];
  const localCandidates = [
    path.join(os.homedir(), ".config", "vibe-bridge", "commands.local.yml"),
  ].filter(Boolean) as string[];

  const resolvedBase = baseEnv ? resolvePathFrom(process.cwd(), baseEnv) : await findFirstExisting(candidates);
  const resolvedLocal = localEnv
    ? resolvePathFrom(process.cwd(), localEnv)
    : await findFirstExisting(localCandidates);

  if (baseEnv && resolvedBase && !(await fileExists(resolvedBase))) {
    throw new Error(`Commands file not found: ${resolvedBase}`);
  }
  if (localEnv && resolvedLocal && !(await fileExists(resolvedLocal))) {
    throw new Error(`Commands local file not found: ${resolvedLocal}`);
  }

  const registries: CommandRegistry[] = [];
  if (resolvedBase && (await fileExists(resolvedBase))) {
    registries.push(await loadCommandsFile(resolvedBase));
  }
  if (resolvedLocal && (await fileExists(resolvedLocal))) {
    registries.push(await loadCommandsFile(resolvedLocal));
  }
  if (registries.length === 0) return undefined;
  const merged: CommandRegistry = { commands: {}, sources: [] };
  for (const registry of registries) {
    merged.sources.push(...registry.sources);
    Object.assign(merged.commands, registry.commands);
  }
  return merged;
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

type FlowlogQueueCallback = { url: string; headers: Record<string, string> };

type FlowlogQueueTask = {
  id: string;
  tenantId: string;
  userEmail: string;
  kind: string;
  request: Record<string, unknown>;
  callback: FlowlogQueueCallback | null;
};

const normalizeFlowlogQueueCallback = (value: unknown): FlowlogQueueCallback | null => {
  const record = asRecord(value);
  if (!record) return null;
  const url = getString(record.url);
  if (!url) return null;
  const headersRaw = asRecord(record.headers) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headersRaw)) {
    const text = getString(entry);
    if (!text) continue;
    headers[key] = text;
  }
  return { url, headers };
};

const normalizeFlowlogQueueTask = (value: unknown): FlowlogQueueTask | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = getString(record.id);
  const tenantId = getString(record.tenantId);
  const kind = getString(record.kind);
  if (!id || !tenantId || !kind) return null;
  const userEmail = getString(record.userEmail) || "";
  const request = asRecord(record.request) ?? {};
  const callback = normalizeFlowlogQueueCallback(record.callback);
  return { id, tenantId, userEmail, kind, request, callback };
};

const normalizeFlowlogQueueTasks = (value: unknown): FlowlogQueueTask[] => {
  const record = asRecord(value);
  const tasksRaw = record?.tasks;
  if (!Array.isArray(tasksRaw)) return [];
  const out: FlowlogQueueTask[] = [];
  for (const entry of tasksRaw) {
    const task = normalizeFlowlogQueueTask(entry);
    if (!task) continue;
    out.push(task);
  }
  return out;
};

const notifyFlowlogQueueCallback = async (
  task: FlowlogQueueTask,
  config: RunnerConfig,
  result: JobResult,
): Promise<void> => {
  if (!task.callback) throw new Error("Missing callback");
  const spec: JobCallbackSpec = { url: task.callback.url, headers: task.callback.headers, timeoutMs: 20000 };
  const payload = {
    jobId: task.id,
    tenantId: task.tenantId,
    kind: `flowlogQueue:${task.kind}`,
    phase: null,
    projectId: null,
    result,
    runnerId: config.runnerId || null,
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await postJobCallback(spec, payload);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts) throw error;
      console.warn(`[flowlog-queue] callback retry (${attempt}/${maxAttempts}): ${message}`);
      await delay(500 * attempt);
    }
  }
};

const executeFlowlogQueueTask = async (task: FlowlogQueueTask, config: RunnerConfig): Promise<void> => {
  const runnerId = config.runnerId || os.hostname();
  const artifactsInline: Record<string, string> = { runnerId };

  try {
    if (task.kind === "timeline_post") {
      const line = getString(task.request.line);
      if (!line) throw new Error("Missing request.line");

      const result: JobResult = {
        jobId: task.id,
        status: "completed",
        finishedAt: nowIso(),
        artifactsInline,
      };
      await notifyFlowlogQueueCallback(task, config, result);
      return;
    }

    throw new Error(`Unknown Flowlog queue task kind: ${task.kind}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: JobResult = {
      jobId: task.id,
      status: "failed",
      finishedAt: nowIso(),
      artifactsInline,
      errorMessage: message,
    };
    try {
      await notifyFlowlogQueueCallback(task, config, result);
    } catch (notifyError) {
      console.error("[flowlog-queue] callback failed", notifyError);
    }
  }
};

const runFlowlogQueueOnce = async (config: RunnerConfig): Promise<boolean> => {
  const baseUrl = config.flowlogQueueBaseUrl;
  const token = config.flowlogQueueToken;
  if (!baseUrl || !token) return false;

  const workerId = config.runnerId || os.hostname();
  const payload = await postJson(baseUrl, token, "/api/integrations/vibe-bridge/jobs/claim", { workerId, limit: 1 });
  const tasks = normalizeFlowlogQueueTasks(payload);
  if (tasks.length === 0) return false;
  for (const task of tasks) {
    await executeFlowlogQueueTask(task, config);
  }
  return true;
};

const isNotFoundError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Request failed 404:");
};

const normalizeFlowalignQueueJobs = (value: unknown): JobSpec[] => {
  const record = asRecord(value);
  const tasksRaw = record?.tasks;
  if (!Array.isArray(tasksRaw)) return [];

  const out: JobSpec[] = [];
  for (const entry of tasksRaw) {
    const task = asRecord(entry);
    if (!task) continue;
    const id = getString(task.id);
    const tenantId = getString(task.tenantId);
    const kind = getString(task.kind);
    if (!id || !tenantId || !kind) continue;

    const requestedAt = getString(task.requestedAt) || nowIso();
    const params = asRecord(task.params) ?? {};

    const repoRaw = asRecord(task.repo);
    const repoUrl = getString(repoRaw?.url);
    const repo = repoUrl
      ? {
          url: repoUrl,
          ref: getString(repoRaw?.ref),
          subdir: getString(repoRaw?.subdir),
        }
      : undefined;

    const commandsRaw = asRecord(task.commands);
    const plan = getString(commandsRaw?.plan);
    const execute = getString(commandsRaw?.execute);
    const commands = plan || execute ? { plan, execute } : undefined;

    const job: JobSpec = {
      id,
      tenantId,
      kind: kind as JobSpec["kind"],
      phase: getString(task.phase) as JobSpec["phase"],
      projectId: getString(task.projectId),
      repo,
      commands,
      planOutputPath: getString(task.planOutputPath),
      context: getString(task.context),
      params,
      idempotencyKey: getString(task.idempotencyKey),
      timeoutSec: getNumber(task.timeoutSec),
      requestedAt,
    };

    out.push(job);
  }

  return out;
};

const ensureControlPlaneJob = async (job: JobSpec, config: RunnerConfig): Promise<void> => {
  try {
    await getJson(config.apiBaseUrl, config.token, `/jobs/${encodeURIComponent(job.id)}`);
    return;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  await postJson(config.apiBaseUrl, config.token, "/jobs", job);
};

const runFlowalignQueueOnce = async (config: RunnerConfig): Promise<boolean> => {
  const baseUrl = config.flowalignQueueBaseUrl;
  const token = config.flowalignQueueToken;
  if (!baseUrl || !token) return false;

  const workerId = config.runnerId || os.hostname();
  const payload = await postJson(baseUrl, token, "/api/integrations/vibe-bridge/jobs/claim", { workerId, limit: 1 });
  const tasks = normalizeFlowalignQueueJobs(payload);
  if (tasks.length === 0) return false;
  for (const task of tasks) {
    await ensureControlPlaneJob(task, config);
  }
  return true;
};

const normalizeLlmBaseUrl = (value: string) => value.replace(/\/$/, "");
const normalizeChatPath = (value: string | undefined) => {
  const pathName = (value || "/chat/completions").trim();
  if (!pathName) return "/chat/completions";
  return pathName.startsWith("/") ? pathName : `/${pathName}`;
};

const getLlmConfig = (params?: Record<string, unknown>): LlmConfig => {
  const baseUrl =
    getString(params?.llmBaseUrl) ||
    getString(params?.baseUrl) ||
    resolveEnv("VIBE_BRIDGE_LLM_BASE_URL", "FLOWLOG_LLM_BASE_URL", "NEXA_LLM_BASE_URL") ||
    "http://127.0.0.1:1234/v1";
  const apiKey =
    getString(params?.llmApiKey) ||
    getString(params?.apiKey) ||
    resolveEnv("VIBE_BRIDGE_LLM_API_KEY", "FLOWLOG_LLM_API_KEY", "NEXA_LLM_API_KEY") ||
    "sk-local";
  const model =
    getString(params?.llmModel) ||
    getString(params?.model) ||
    resolveEnv("VIBE_BRIDGE_LLM_MODEL", "FLOWLOG_LLM_MODEL", "NEXA_LLM_MODEL") ||
    "auto";
  const timeoutMs =
    getNumber(params?.llmTimeoutMs) ||
    getNumber(params?.timeoutMs) ||
    getNumber(resolveEnv("VIBE_BRIDGE_LLM_TIMEOUT_MS", "FLOWLOG_LLM_TIMEOUT_MS")) ||
    20000;
  return {
    baseUrl: normalizeLlmBaseUrl(baseUrl),
    apiKey,
    model,
    timeoutMs,
    pathName: normalizeChatPath(getString(params?.llmPath) || getString(params?.pathName)),
  };
};

const getOpenAiCompatibleConfig = (params?: Record<string, unknown>): LlmConfig => {
  const baseUrl =
    getString(params?.baseUrl) ||
    getString(params?.openaiBaseUrl) ||
    resolveEnv("VIBE_BRIDGE_OPENAI_BASE_URL", "OPENAI_BASE_URL") ||
    "http://127.0.0.1:1234/v1";
  const apiKey =
    getString(params?.apiKey) ||
    getString(params?.openaiApiKey) ||
    resolveEnv("VIBE_BRIDGE_OPENAI_API_KEY", "OPENAI_API_KEY") ||
    "sk-local";
  const model =
    getString(params?.model) ||
    getString(params?.openaiModel) ||
    resolveEnv("VIBE_BRIDGE_OPENAI_MODEL", "OPENAI_MODEL") ||
    "auto";
  const timeoutMs =
    getNumber(params?.timeoutMs) ||
    getNumber(params?.openaiTimeoutMs) ||
    getNumber(resolveEnv("VIBE_BRIDGE_OPENAI_TIMEOUT_MS", "OPENAI_TIMEOUT_MS")) ||
    20000;
  return {
    baseUrl: normalizeLlmBaseUrl(baseUrl),
    apiKey,
    model,
    timeoutMs,
    pathName: normalizeChatPath(getString(params?.pathName) || getString(params?.openaiPath)),
  };
};

const getCursorApiConfig = (params?: Record<string, unknown>): LlmConfig => {
  const baseUrl =
    getString(params?.cursorBaseUrl) ||
    getString(params?.baseUrl) ||
    resolveEnv("VIBE_BRIDGE_CURSOR_API_BASE_URL", "CURSOR_API_BASE_URL") ||
    "https://api.cursor.com/v1";
  const apiKey =
    getString(params?.cursorApiKey) ||
    getString(params?.apiKey) ||
    resolveEnv("VIBE_BRIDGE_CURSOR_API_KEY", "CURSOR_API_KEY") ||
    "";
  const model =
    getString(params?.cursorModel) ||
    getString(params?.model) ||
    resolveEnv("VIBE_BRIDGE_CURSOR_API_MODEL", "CURSOR_MODEL") ||
    "gpt-5";
  const timeoutMs =
    getNumber(params?.cursorTimeoutMs) ||
    getNumber(params?.timeoutMs) ||
    getNumber(resolveEnv("VIBE_BRIDGE_CURSOR_API_TIMEOUT_MS", "CURSOR_API_TIMEOUT_MS")) ||
    20000;
  return {
    baseUrl: normalizeLlmBaseUrl(baseUrl),
    apiKey,
    model,
    timeoutMs,
    pathName: normalizeChatPath(getString(params?.cursorPath) || getString(params?.pathName)),
  };
};

const getChatConfigForBackend = (backend: AiBackend, params?: Record<string, unknown>): LlmConfig => {
  if (backend === "cursor-api") return getCursorApiConfig(params);
  if (backend === "openai-compatible") return getOpenAiCompatibleConfig(params);
  return getLlmConfig(params);
};

const requestChatCompletion = async (
  messages: LlmMessage[],
  options: { temperature?: number; config?: LlmConfig } = {},
) => {
  const config = options.config || getLlmConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (!config.apiKey) throw new Error("Missing API key for chat completion backend");
    const response = await fetch(`${config.baseUrl}${config.pathName}`, {
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
): Promise<{ status: "skipped" | "ok" | "empty"; posted: number; candidates: MoyattoCandidate[] }> => {
  const params = asRecord(job.params) ?? {};
  const flowlog = asRecord(params.flowlog) ?? null;
  const userEmail = flowlog ? getString(flowlog.userEmail) : undefined;
  if (!userEmail) return { status: "skipped", posted: 0, candidates: [] };

  const title = input.title.trim();
  if (!title) return { status: "skipped", posted: 0, candidates: [] };
  await sendEvent(runnerConfig, job, "status", "Moyatto: generating candidates");

  const messages = buildMoyattoMessages(title, input.description, input.taskId);
  const content = await requestChatCompletion(messages, { temperature: 0.2 });
  const candidates = parseCandidates(content);
  if (candidates.length === 0) {
    await sendEvent(runnerConfig, job, "status", "Moyatto: no candidates");
    return { status: "empty", posted: 0, candidates: [] };
  }

  const seen = new Set<string>();
  const unique: MoyattoCandidate[] = [];
  for (const item of candidates) {
    const text = truncate(item.text, 200);
    const reason = truncate(item.reason, 200);
    if (!text || !reason) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ text, reason });
  }
  await sendEvent(runnerConfig, job, "status", `Moyatto: generated ${unique.length}`);
  return { status: "ok", posted: unique.length, candidates: unique };
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

const runExec = async (
  exec: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
  onChunk?: (chunk: string) => Promise<void>,
) => {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const [cmd, ...args] = exec;
    const child = spawn(cmd, args, {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
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

const normalizeAiBackend = (value: string | undefined): AiBackend => {
  const normalized = (value || "codex-cli").trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, AiBackend> = {
    codex: "codex-cli",
    "codex-app": "codex-app-server",
    "cursor": "cursor-cli",
    "cursor-agent": "cursor-cli",
    "cursor-http": "cursor-api",
    "claude": "claude-code",
    "claude-cli": "claude-code",
    "claude-code-cli": "claude-code",
    llm: "local-llm",
    "local-openai": "local-llm",
    openai: "openai-compatible",
    "openai-api": "openai-compatible",
    "openai-compatible-api": "openai-compatible",
  };
  if (aliases[normalized]) return aliases[normalized];
  if (
    normalized === "codex-cli" ||
    normalized === "codex-app-server" ||
    normalized === "cursor-cli" ||
    normalized === "cursor-api" ||
    normalized === "claude-code" ||
    normalized === "local-llm" ||
    normalized === "openai-compatible" ||
    normalized === "command"
  ) {
    return normalized;
  }
  throw new Error(`Unknown AI backend: ${value}`);
};

const resolveAiBackend = (job: JobSpec, config: RunnerConfig): AiBackend => {
  const params = asRecord(job.params) ?? {};
  return normalizeAiBackend(
    getString(params.aiBackend) ||
      getString(params.backend) ||
      getString(params.executor) ||
      config.defaultAiBackend,
  );
};

const buildAiPrompt = (job: JobSpec, phase: "plan" | "execute"): string => {
  const params = asRecord(job.params) ?? {};
  const prompt =
    getString(params.prompt) ||
    getString(params.input) ||
    getString(params.task) ||
    getString(params.request) ||
    job.context;
  if (!prompt) {
    throw new Error("Missing AI prompt (use job.context or params.prompt)");
  }
  const source = [
    `Vibe Bridge job: ${job.id}`,
    `Tenant: ${job.tenantId}`,
    job.projectId ? `Project: ${job.projectId}` : null,
    `Phase: ${phase}`,
    "",
    prompt,
  ]
    .filter((entry) => entry !== null)
    .join("\n");
  return source;
};

const renderCommandTemplate = (
  template: string,
  values: { cwd: string; prompt: string; promptFile: string; outputFile: string; phase: string },
) => {
  const replacements: Record<string, string> = {
    "{{cwd}}": values.cwd,
    "{{prompt}}": values.prompt,
    "{{promptFile}}": values.promptFile,
    "{{outputFile}}": values.outputFile,
    "{{phase}}": values.phase,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value.replace(/'/g, `'\\''`));
  }
  return rendered;
};

const readOptionalFile = async (filePath: string): Promise<string> => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const runAiCommandTemplate = async (
  template: string,
  input: { cwd: string; prompt: string; phase: string },
  onChunk: (chunk: string) => Promise<void>,
) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-bridge-ai-"));
  const promptFile = path.join(tempDir, "prompt.txt");
  const outputFile = path.join(tempDir, "output.txt");
  try {
    await fs.writeFile(promptFile, input.prompt, "utf8");
    const command = renderCommandTemplate(template, { ...input, promptFile, outputFile });
    const completed = await runShell(command, input.cwd, onChunk);
    const output = (await readOptionalFile(outputFile)) || completed.stdout;
    return { ...completed, output };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
};

const resolveCodexAppServerRemote = async (config: RunnerConfig, cwd: string): Promise<string> => {
  if (config.codexAppServerRemote) return config.codexAppServerRemote;
  const codexBin = config.codexBin || "codex";
  await runExec([codexBin, "app-server", "daemon", "start"], cwd);
  const version = await runExec([codexBin, "app-server", "daemon", "version"], cwd);
  const parsed = safeJsonParse(version.stdout);
  const socketPath = asRecord(parsed) ? getString(asRecord(parsed)?.socketPath) : undefined;
  if (!socketPath) {
    throw new Error("Codex app-server daemon did not report a socketPath");
  }
  return `unix://${socketPath}`;
};

const runCodexAi = async (
  backend: "codex-cli" | "codex-app-server",
  job: JobSpec,
  config: RunnerConfig,
  input: { cwd: string; prompt: string; phase: "plan" | "execute" },
  onChunk: (chunk: string) => Promise<void>,
) => {
  const params = asRecord(job.params) ?? {};
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-bridge-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  try {
    const codexBin = config.codexBin || getString(params.codexBin) || "codex";
    const approvalPolicy = getString(params.approvalPolicy) || "never";
    const sandbox = getString(params.sandbox) || (input.phase === "execute" ? "workspace-write" : "read-only");
    const args = [
      codexBin,
      ...(backend === "codex-app-server"
        ? ["--remote", await resolveCodexAppServerRemote(config, input.cwd)]
        : []),
      "exec",
      "--ask-for-approval",
      approvalPolicy,
      "--sandbox",
      sandbox,
      "--skip-git-repo-check",
      "-C",
      input.cwd,
      "--output-last-message",
      outputFile,
    ];
    const model = getString(params.model) || getString(params.codexModel);
    if (model) args.push("--model", model);
    const profile = getString(params.profile) || getString(params.codexProfile);
    if (profile) args.push("--profile", profile);
    args.push(input.prompt);
    const completed = await runExec(args, input.cwd, undefined, onChunk);
    const output = (await readOptionalFile(outputFile)) || completed.stdout;
    return { ...completed, output };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
};

const runCursorCliAi = async (
  job: JobSpec,
  config: RunnerConfig,
  input: { cwd: string; prompt: string; phase: "plan" | "execute" },
  onChunk: (chunk: string) => Promise<void>,
) => {
  const params = asRecord(job.params) ?? {};
  if (config.cursorCommand) {
    return runAiCommandTemplate(config.cursorCommand, input, onChunk);
  }

  const cursorBin = config.cursorBin || getString(params.cursorBin) || "cursor-agent";
  const args = [
    cursorBin,
    "--print",
    "--output-format",
    getString(params.outputFormat) || getString(params.cursorOutputFormat) || "text",
    "--trust",
    "--workspace",
    input.cwd,
  ];
  const model = getString(params.model) || getString(params.cursorModel);
  if (model) args.push("--model", model);
  const mode = getString(params.mode) || getString(params.cursorMode) || (input.phase === "plan" ? "plan" : undefined);
  if (mode) args.push("--mode", mode);
  const sandbox = getString(params.sandbox) || getString(params.cursorSandbox);
  if (sandbox) args.push("--sandbox", sandbox);
  if (params.force === true || params.cursorForce === true || params.yolo === true) args.push("--force");
  args.push(input.prompt);
  const completed = await runExec(args, input.cwd, undefined, onChunk);
  return { ...completed, output: completed.stdout };
};

const runClaudeCodeAi = async (
  job: JobSpec,
  config: RunnerConfig,
  input: { cwd: string; prompt: string; phase: "plan" | "execute" },
  onChunk: (chunk: string) => Promise<void>,
) => {
  const params = asRecord(job.params) ?? {};
  const claudeBin = config.claudeBin || getString(params.claudeBin) || "claude";
  const args = [
    claudeBin,
    "--print",
    "--output-format",
    getString(params.outputFormat) || getString(params.claudeOutputFormat) || "text",
  ];
  const model = getString(params.model) || getString(params.claudeModel);
  if (model) args.push("--model", model);
  const permissionMode =
    getString(params.permissionMode) ||
    getString(params.claudePermissionMode) ||
    (input.phase === "plan" ? "plan" : "acceptEdits");
  if (permissionMode) args.push("--permission-mode", permissionMode);
  const systemPrompt = getString(params.systemPrompt) || getString(params.claudeSystemPrompt);
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  const appendSystemPrompt = getString(params.appendSystemPrompt) || getString(params.claudeAppendSystemPrompt);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  const tools = getString(params.tools) || getString(params.claudeTools);
  if (tools) args.push("--tools", tools);
  const allowedTools = getString(params.allowedTools) || getString(params.claudeAllowedTools);
  if (allowedTools) args.push("--allowedTools", allowedTools);
  const disallowedTools = getString(params.disallowedTools) || getString(params.claudeDisallowedTools);
  if (disallowedTools) args.push("--disallowedTools", disallowedTools);
  if (params.dangerouslySkipPermissions === true || params.claudeDangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }
  args.push(input.prompt);
  const completed = await runExec(args, input.cwd, undefined, onChunk);
  return { ...completed, output: completed.stdout };
};

const executeAiJob = async (job: JobSpec, config: RunnerConfig): Promise<JobResult> => {
  const phase = job.phase || "execute";
  const { checkoutDir } = await ensureRepo(job, config.workspaceRoot);
  const backend = resolveAiBackend(job, config);
  const prompt = buildAiPrompt(job, phase);
  await sendEvent(config, job, "status", `AI backend started: ${backend}`);

  const outputChunks: string[] = [];
  const onChunk = async (chunk: string) => {
    outputChunks.push(chunk);
    await sendEvent(config, job, "log", chunk);
  };

  try {
    let code: number | null = 0;
    let stdout = "";
    let stderr = "";
    let output = "";

    if (backend === "local-llm" || backend === "openai-compatible" || backend === "cursor-api") {
      const params = asRecord(job.params) ?? {};
      output = await requestChatCompletion([
        { role: "system", content: "You are an automation worker. Return the requested result directly." },
        { role: "user", content: prompt },
      ], { config: getChatConfigForBackend(backend, params) });
      stdout = output;
    } else if (backend === "codex-cli" || backend === "codex-app-server") {
      const completed = await runCodexAi(backend, job, config, { cwd: checkoutDir, prompt, phase }, onChunk);
      code = completed.code;
      stdout = completed.stdout;
      stderr = completed.stderr;
      output = completed.output;
    } else if (backend === "cursor-cli") {
      const completed = await runCursorCliAi(job, config, { cwd: checkoutDir, prompt, phase }, onChunk);
      code = completed.code;
      stdout = completed.stdout;
      stderr = completed.stderr;
      output = completed.output;
    } else if (backend === "claude-code") {
      const completed = await runClaudeCodeAi(job, config, { cwd: checkoutDir, prompt, phase }, onChunk);
      code = completed.code;
      stdout = completed.stdout;
      stderr = completed.stderr;
      output = completed.output;
    } else {
      const template = config.aiCommand;
      if (!template) {
        throw new Error("VIBE_BRIDGE_AI_COMMAND is required for command backend");
      }
      const completed = await runAiCommandTemplate(template, { cwd: checkoutDir, prompt, phase }, onChunk);
      code = completed.code;
      stdout = completed.stdout;
      stderr = completed.stderr;
      output = completed.output;
    }

    const status: JobResult["status"] = code === 0 ? "completed" : "failed";
    const text = output || stdout || outputChunks.join("");
    const artifactsInline: Record<string, string> =
      phase === "plan"
        ? { plan: text, aiBackend: backend }
        : { response: text, aiBackend: backend };
    const result: JobResult = {
      jobId: job.id,
      status,
      finishedAt: nowIso(),
      artifactsInline,
      errorMessage: status === "failed" ? stderr || `AI backend failed with code ${code}` : undefined,
    };
    await sendEvent(config, job, "status", `AI backend finished: ${backend} (${status})`);
    await completeJob(config, job, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: JobResult = {
      jobId: job.id,
      status: "failed",
      finishedAt: nowIso(),
      artifactsInline: { aiBackend: backend },
      errorMessage: message,
    };
    await sendEvent(config, job, "status", `AI backend failed: ${message}`).catch(() => null);
    await completeJob(config, job, result);
    return result;
  }
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

type JobCallbackSpec = { url: string; headers: Record<string, string>; timeoutMs: number };

const resolveJobCallbackSpec = (job: JobSpec): JobCallbackSpec | null => {
  const params = asRecord(job.params) ?? {};
  const raw = asRecord(params.callback) ?? asRecord(params.webhook) ?? null;
  if (!raw) return null;
  const url = getString(raw.url);
  if (!url) return null;
  const headersRaw = asRecord(raw.headers) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersRaw)) {
    const entry = getString(value);
    if (!entry) continue;
    headers[key] = entry;
  }
  const timeoutMs = getNumber(raw.timeoutMs) || 20000;
  return { url, headers, timeoutMs };
};

const postJobCallback = async (spec: JobCallbackSpec, payload: unknown) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    const res = await fetch(spec.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...spec.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`Callback failed ${res.status}: ${truncate(rawText, 500)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const maybeNotifyJobCallback = async (config: RunnerConfig, job: JobSpec, result: JobResult) => {
  const spec = resolveJobCallbackSpec(job);
  if (!spec) return;

  const payload = {
    jobId: job.id,
    tenantId: job.tenantId,
    kind: job.kind,
    phase: job.phase || null,
    projectId: job.projectId || null,
    result,
    runnerId: config.runnerId || null,
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await postJobCallback(spec, payload);
      try {
        await sendEvent(config, job, "status", `Callback: ok (${attempt}/${maxAttempts})`);
      } catch {
        // ignore
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        try {
          await sendEvent(config, job, "status", `Callback retry (${attempt}/${maxAttempts}): ${message}`);
        } catch {
          // ignore
        }
        await delay(500 * attempt);
        continue;
      }
      try {
        await sendEvent(config, job, "status", `Callback failed: ${message}`);
      } catch {
        // ignore
      }
    }
  }
};

const completeJob = async (config: RunnerConfig, job: JobSpec, result: JobResult) => {
  await postJson(config.apiBaseUrl, config.token, `/jobs/${result.jobId}/complete`, { result });
  await maybeNotifyJobCallback(config, job, result).catch(() => null);
};

const resolveAllowlistedCommand = (
  job: JobSpec,
  phase: "plan" | "execute",
  config: RunnerConfig,
): ResolvedCommand | null => {
  const params = job.params || {};
  const commandId =
    getString(params[`${phase}CommandId`]) ||
    getString(params.commandId) ||
    getString(params[`${phase}CommandID`]) ||
    getString(params.commandID);
  if (!commandId) return null;
  const registry = config.commandsRegistry;
  if (!registry) {
    throw new Error(`commandId "${commandId}" provided but no commands registry is configured`);
  }
  const spec = registry.commands[commandId];
  if (!spec) {
    throw new Error(`Unknown commandId "${commandId}" (sources: ${registry.sources.join(", ")})`);
  }
  const phaseArgs =
    coerceStringArgs(params[`${phase}CommandArgs`]) ||
    coerceStringArgs(params.commandArgs) ||
    coerceStringArgs(params[`${phase}CommandARGS`]) ||
    coerceStringArgs(params.commandARGS);
  if (phaseArgs && phaseArgs.length > 0 && !spec.allowArgs) {
    throw new Error(`commandId "${commandId}" does not allow args`);
  }
  const args = spec.args ? [...spec.args] : [];
  if (phaseArgs && phaseArgs.length > 0) {
    args.push(...phaseArgs);
  }
  return {
    kind: "exec",
    exec: [...spec.exec, ...args],
    cwd: spec.cwd,
    env: spec.env,
  };
};

const resolveCommand = (job: JobSpec, phase: "plan" | "execute", config: RunnerConfig): ResolvedCommand | null => {
  const allowlisted = resolveAllowlistedCommand(job, phase, config);
  if (allowlisted) return allowlisted;
  if (config.commandsStrict) {
    throw new Error(`commandId is required (phase=${phase})`);
  }
  const params = job.params || {};
  const paramCommand =
    typeof params[`${phase}Command`] === "string" ? String(params[`${phase}Command`]) : undefined;
  const command = phase === "plan"
    ? job.commands?.plan || paramCommand || config.defaultPlanCommand
    : job.commands?.execute || paramCommand || config.defaultExecuteCommand;
  if (!command) return null;
  return { kind: "shell", command };
};

export const executeJob = async (job: JobSpec, config: RunnerConfig): Promise<JobResult> => {
  const jobKind = String(job.kind || "");
  if (jobKind === "ai") {
    return executeAiJob(job, config);
  }
  if (jobKind === "vibeKanban" || jobKind.startsWith("vibeKanban.")) {
    return executeVibeKanbanJob(job, config);
  }

  const phase = job.phase || "execute";
  let resolved: ResolvedCommand | null = null;
  try {
    resolved = resolveCommand(job, phase, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: JobResult = {
      jobId: job.id,
      status: "failed",
      finishedAt: nowIso(),
      errorMessage: message,
    };
    await completeJob(config, job, result);
    return result;
  }
  if (!resolved) {
    const result: JobResult = {
      jobId: job.id,
      status: "failed",
      finishedAt: nowIso(),
      errorMessage: `Missing ${phase} command`,
    };
    await completeJob(config, job, result);
    return result;
  }

  const { checkoutDir } = await ensureRepo(job, config.workspaceRoot);
  await sendEvent(config, job, "status", `Started ${phase}`);

  const outputChunks: string[] = [];
  const onChunk = async (chunk: string) => {
    outputChunks.push(chunk);
    await sendEvent(config, job, "log", chunk);
  };
  const commandCwd = resolved.kind === "exec" && resolved.cwd ? resolved.cwd : checkoutDir;
  const { code, stdout, stderr } =
    resolved.kind === "exec"
      ? await runExec(resolved.exec, commandCwd, resolved.env, onChunk)
      : await runShell(resolved.command, commandCwd, onChunk);

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
  await completeJob(config, job, result);
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
      await completeJob(config, job, result);
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
      let moyattoCandidates: MoyattoCandidate[] | undefined;
      let moyattoError: string | undefined;
      try {
        const outcome = await maybeEnqueueMoyattoAfterCreateTask(config, job, { title, description, taskId: task.id });
        moyattoStatus = outcome.status;
        moyattoPosted = outcome.posted;
        moyattoCandidates = outcome.candidates;
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
      if (moyattoCandidates && moyattoCandidates.length > 0) {
        artifactsInline.moyattoCandidates = JSON.stringify(moyattoCandidates);
      }
      if (moyattoError) artifactsInline.moyattoError = moyattoError;
      const result: JobResult = {
        jobId: job.id,
        status: "completed",
        finishedAt: nowIso(),
        artifactsInline,
      };
      await completeJob(config, job, result);
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
      await completeJob(config, job, result);
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
    await completeJob(config, job, result);
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

const runBridgeOrFlowlogOnce = async (config: RunnerConfig): Promise<boolean> => {
  const handled = await runOnce(config);
  if (handled) return true;
  const handledFlowlog = await runFlowlogQueueOnce(config);
  if (handledFlowlog) return true;
  return runFlowalignQueueOnce(config);
};

export const runLoop = async (config: RunnerConfig) => {
  while (true) {
    try {
      const handled = await runBridgeOrFlowlogOnce(config);
      if (!handled) await delay((config.pollIntervalSec || 5) * 1000);
    } catch (error) {
      console.error("[vibe-bridge] runner error", error);
      await delay((config.pollIntervalSec || 5) * 1000);
    }
  }
};

const loadEnvConfig = async (): Promise<RunnerConfig> => {
  const apiBaseUrl = (process.env.VIBE_BRIDGE_API_BASE || "").trim();
  const token = (process.env.VIBE_BRIDGE_API_TOKEN || "").trim();
  const workspaceRoot = (process.env.VIBE_BRIDGE_WORKSPACE_ROOT || "").trim();
  if (!apiBaseUrl || !token || !workspaceRoot) {
    throw new Error("Missing VIBE_BRIDGE_API_BASE / VIBE_BRIDGE_API_TOKEN / VIBE_BRIDGE_WORKSPACE_ROOT");
  }
  const commandsRegistry = await resolveCommandsRegistry();
  return {
    apiBaseUrl,
    token,
    workspaceRoot,
    pollIntervalSec: Number(process.env.VIBE_BRIDGE_POLL_INTERVAL_SEC || "5"),
    leaseTtlSec: Number(process.env.VIBE_BRIDGE_LEASE_TTL_SEC || "300"),
    runnerId: process.env.VIBE_BRIDGE_RUNNER_ID || undefined,
    defaultPlanCommand: process.env.VIBE_BRIDGE_PLAN_COMMAND || undefined,
    defaultExecuteCommand: process.env.VIBE_BRIDGE_EXECUTE_COMMAND || undefined,
    flowlogQueueBaseUrl: resolveEnv("FLOWLOG_VIBE_BRIDGE_QUEUE_BASE_URL"),
    flowlogQueueToken: resolveEnv("FLOWLOG_SYNC_TOKEN"),
    flowalignQueueBaseUrl: resolveEnv("FLOWALIGN_VIBE_BRIDGE_QUEUE_BASE_URL"),
    flowalignQueueToken: resolveEnv("FLOWALIGN_VIBE_BRIDGE_QUEUE_TOKEN", "FLOWALIGN_VIBE_BRIDGE_WEBHOOK_TOKEN"),
    filterTenantId: process.env.VIBE_BRIDGE_RUNNER_TENANT_ID || undefined,
    filterKinds: process.env.VIBE_BRIDGE_RUNNER_KINDS || undefined,
    filterPhases: process.env.VIBE_BRIDGE_RUNNER_PHASES || undefined,
    defaultAiBackend: resolveEnv("VIBE_BRIDGE_AI_BACKEND"),
    codexBin: resolveEnv("VIBE_BRIDGE_CODEX_BIN", "CODEX_BIN"),
    codexAppServerRemote: resolveEnv("VIBE_BRIDGE_CODEX_APP_SERVER_REMOTE"),
    cursorBin: resolveEnv("VIBE_BRIDGE_CURSOR_BIN", "CURSOR_BIN"),
    cursorCommand: resolveEnv("VIBE_BRIDGE_CURSOR_COMMAND"),
    claudeBin: resolveEnv("VIBE_BRIDGE_CLAUDE_BIN", "CLAUDE_BIN"),
    aiCommand: resolveEnv("VIBE_BRIDGE_AI_COMMAND"),
    commandsRegistry,
    commandsStrict: process.env.VIBE_BRIDGE_COMMANDS_STRICT === "1",
  };
};

const main = async () => {
  const config = await loadEnvConfig();
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
