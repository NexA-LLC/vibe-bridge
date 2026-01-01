import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

import type {
  JobEvent,
  JobLease,
  JobResult,
  JobSpec,
  JobState,
} from "@vibe-bridge/shared";

type PlanStatus = "pending" | "approved" | "rejected";

type JobRecord = JobSpec & {
  state: JobState;
  createdAt: string;
  updatedAt: string;
  lease?: JobLease;
  result?: JobResult;
  events: JobEvent[];
  planStatus?: PlanStatus;
  planText?: string;
  planTruncated?: boolean;
};

const { Pool } = pg;

const API_TOKEN = (process.env.API_TOKEN || "").trim();
const PORT = Number(process.env.PORT || "3900");
const DEFAULT_LEASE_TTL_SEC = Number(process.env.LEASE_TTL_SEC || "300");
const PLAN_WEBHOOK_URLS = (process.env.PLAN_WEBHOOK_URLS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const PLAN_WEBHOOK_TOKEN = (process.env.PLAN_WEBHOOK_TOKEN || "").trim();
const PLAN_STORAGE_BACKEND = (process.env.PLAN_STORAGE_BACKEND || "memory").trim().toLowerCase();
const PLAN_TABLE = (process.env.PLAN_TABLE || "vibe_bridge_plans").trim();
const PLAN_INLINE_MAX_CHARS = Number(process.env.PLAN_INLINE_MAX_CHARS || "0");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const jobs = new Map<string, JobRecord>();
const eventIndex = new Set<string>();
let planPool: pg.Pool | null = null;
let planInitPromise: Promise<void> | null = null;

const json = (res: ServerResponse, status: number, payload: unknown) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const error = (res: ServerResponse, status: number, message: string) => {
  json(res, status, { error: message });
};

const noContent = (res: ServerResponse) => {
  res.writeHead(204);
  res.end();
};

const nowIso = () => new Date().toISOString();

const ensurePlanPool = async () => {
  if (PLAN_STORAGE_BACKEND !== "postgres") return null;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required when PLAN_STORAGE_BACKEND=postgres");
  }
  if (!/^[a-zA-Z0-9_]+$/.test(PLAN_TABLE)) {
    throw new Error("PLAN_TABLE must be an identifier with letters/numbers/underscore only");
  }
  if (!planInitPromise) {
    planInitPromise = (async () => {
      planPool = new Pool({ connectionString: DATABASE_URL });
      await planPool.query(`
        CREATE TABLE IF NOT EXISTS ${PLAN_TABLE} (
          job_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          plan_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
    })();
  }
  await planInitPromise;
  return planPool;
};

const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (header === `Bearer ${API_TOKEN}`) return true;
  error(res, 401, "Unauthorized");
  return false;
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const normalizeSpec = (spec: Partial<JobSpec>): JobSpec => {
  const id = spec.id || `job_${randomUUID().slice(0, 12)}`;
  return {
    id,
    tenantId: spec.tenantId || "default",
    kind: spec.kind || "cli",
    phase: spec.phase,
    projectId: spec.projectId,
    repo: spec.repo,
    commands: spec.commands,
    planOutputPath: spec.planOutputPath,
    context: spec.context,
    params: spec.params || {},
    idempotencyKey: spec.idempotencyKey,
    timeoutSec: spec.timeoutSec,
    requestedAt: spec.requestedAt || nowIso(),
  };
};

const createJob = (spec: Partial<JobSpec>): JobRecord => {
  const normalized = normalizeSpec(spec);
  const timestamp = nowIso();
  const record: JobRecord = {
    ...normalized,
    state: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
  };
  jobs.set(record.id, record);
  return record;
};

const listQueuedJobs = (filters: {
  tenantId?: string;
  kinds?: Set<string>;
  phases?: Set<string>;
}): JobRecord[] => {
  const records = Array.from(jobs.values()).filter((job) => job.state === "queued");
  return records.filter((job) => {
    if (filters.tenantId && job.tenantId !== filters.tenantId) return false;
    if (filters.kinds && filters.kinds.size > 0 && !filters.kinds.has(job.kind)) return false;
    if (filters.phases && filters.phases.size > 0 && !filters.phases.has(job.phase || "")) return false;
    return true;
  });
};

const leaseJob = (job: JobRecord, ttlSec: number): JobLease => {
  const lease: JobLease = {
    jobId: job.id,
    leaseUntil: new Date(Date.now() + ttlSec * 1000).toISOString(),
    attempt: (job.lease?.attempt || 0) + 1,
  };
  job.lease = lease;
  job.state = "leased";
  job.updatedAt = nowIso();
  return lease;
};

const appendEvents = (job: JobRecord, events: JobEvent[]) => {
  for (const event of events) {
    const key = `${job.id}:${event.id}`;
    if (eventIndex.has(key)) continue;
    eventIndex.add(key);
    job.events.push(event);
  }
  job.updatedAt = nowIso();
};

const findPlanText = (result: JobResult | undefined): string | undefined => {
  if (!result) return undefined;
  if (result.artifactsInline?.plan) return result.artifactsInline.plan;
  if (result.artifacts?.plan) return result.artifacts.plan;
  return undefined;
};

const applyPlanText = async (job: JobRecord, planText?: string) => {
  if (!planText) return;
  const maxChars = Number.isFinite(PLAN_INLINE_MAX_CHARS) ? PLAN_INLINE_MAX_CHARS : 0;
  if (maxChars > 0 && planText.length > maxChars) {
    job.planText = planText.slice(0, maxChars);
    job.planTruncated = true;
  } else {
    job.planText = planText;
  }
  if (PLAN_STORAGE_BACKEND === "postgres") {
    try {
      const pool = await ensurePlanPool();
      if (!pool) return;
      const timestamp = nowIso();
      await pool.query(
        `INSERT INTO ${PLAN_TABLE} (job_id, tenant_id, project_id, plan_text, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (job_id)
         DO UPDATE SET plan_text = EXCLUDED.plan_text, updated_at = EXCLUDED.updated_at`,
        [job.id, job.tenantId, job.projectId ?? null, planText, timestamp],
      );
    } catch (err) {
      console.error("[vibe-bridge] plan store failed", err);
    }
  }
};

const notifyPlan = async (job: JobRecord) => {
  if (PLAN_WEBHOOK_URLS.length === 0) return;
  const payload = {
    jobId: job.id,
    tenantId: job.tenantId,
    projectId: job.projectId,
    phase: job.phase,
    kind: job.kind,
    repo: job.repo,
    planStatus: job.planStatus,
    planText: job.planText,
    planTruncated: job.planTruncated,
    result: job.result,
    requestedAt: job.requestedAt,
    completedAt: job.result?.finishedAt,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (PLAN_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${PLAN_WEBHOOK_TOKEN}`;
  await Promise.all(
    PLAN_WEBHOOK_URLS.map(async (url) => {
      try {
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch {
        // Best-effort webhook; errors stay local.
      }
    }),
  );
};

const parseList = (value: string | null): Set<string> | undefined => {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length ? new Set(items) : undefined;
};

const toNumber = (value: string | null, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    error(res, 400, "Invalid request");
    return;
  }
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/jobs") {
    const body = await readJson(req);
    if (!body || typeof body !== "object") {
      error(res, 400, "Invalid job payload");
      return;
    }
    const record = createJob(body as JobSpec);
    json(res, 201, record);
    return;
  }

  if (req.method === "GET" && pathname === "/jobs/next") {
    const waitSec = toNumber(url.searchParams.get("waitSec"), 0);
    const ttlSec = toNumber(url.searchParams.get("leaseTtlSec"), DEFAULT_LEASE_TTL_SEC);
    const filters = {
      tenantId: url.searchParams.get("tenantId") || undefined,
      kinds: parseList(url.searchParams.get("kinds")),
      phases: parseList(url.searchParams.get("phases")),
    };
    const deadline = Date.now() + waitSec * 1000;
    while (true) {
      const queued = listQueuedJobs(filters);
      if (queued.length > 0) {
        queued.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
        const job = queued[0];
        const lease = leaseJob(job, ttlSec);
        json(res, 200, { job, lease });
        return;
      }
      if (Date.now() >= deadline) break;
      await delay(500);
    }
    noContent(res);
    return;
  }

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)(?:\/([^/]+))?$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    const action = jobMatch[2];
    const job = jobs.get(jobId);
    if (!job) {
      error(res, 404, "Job not found");
      return;
    }

    if (req.method === "GET" && !action) {
      json(res, 200, job);
      return;
    }

    if (req.method === "POST" && action === "heartbeat") {
      const ttlSec = toNumber(url.searchParams.get("leaseTtlSec"), DEFAULT_LEASE_TTL_SEC);
      const lease = leaseJob(job, ttlSec);
      json(res, 200, { lease });
      return;
    }

    if (req.method === "POST" && action === "events") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        error(res, 400, "Invalid events payload");
        return;
      }
      const payload = body as { event?: JobEvent; events?: JobEvent[] };
      const incoming = payload.events || (payload.event ? [payload.event] : []);
      const prepared = incoming.map((evt) => ({
        ...evt,
        id: evt.id || randomUUID(),
        jobId: job.id,
        createdAt: evt.createdAt || nowIso(),
      }));
      appendEvents(job, prepared);
      json(res, 200, { added: prepared.length });
      return;
    }

    if (req.method === "POST" && action === "complete") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        error(res, 400, "Invalid completion payload");
        return;
      }
      const payload = body as { result?: JobResult } & Partial<JobResult>;
      const result = payload.result || (payload as JobResult);
      if (!result || !result.status) {
        error(res, 400, "Missing result");
        return;
      }
      job.result = {
        ...result,
        jobId: job.id,
        finishedAt: result.finishedAt || nowIso(),
      };
      job.state =
        result.status === "completed"
          ? "completed"
          : result.status === "failed"
            ? "failed"
            : "canceled";
      job.updatedAt = nowIso();
      if (job.phase === "plan") {
        job.planStatus = "pending";
        const planText = findPlanText(job.result);
        await applyPlanText(job, planText);
        await notifyPlan(job);
      }
      json(res, 200, job);
      return;
    }

    if (req.method === "POST" && action === "approve") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") {
        error(res, 400, "Invalid approval payload");
        return;
      }
      if (job.phase !== "plan") {
        error(res, 400, "Job is not a plan");
        return;
      }
      const payload = body as {
        status?: PlanStatus;
        approved?: boolean;
        note?: string;
        createExecuteJob?: boolean;
        executeJob?: Partial<JobSpec>;
      };
      const status =
        payload.status ||
        (payload.approved === true ? "approved" : payload.approved === false ? "rejected" : undefined);
      if (!status) {
        error(res, 400, "Missing approval status");
        return;
      }

      const shouldCreate = payload.createExecuteJob !== false && status === "approved";
      let executeJob: JobRecord | null = null;
      if (shouldCreate) {
        const commands = job.commands || {};
        const executeCommand =
          payload.executeJob?.commands?.execute || commands.execute;
        if (!executeCommand) {
          error(res, 400, "Missing execute command");
          return;
        }
        const nextParams = {
          ...(job.params || {}),
          planJobId: job.id,
        };
        if (job.planText) nextParams.planText = job.planText;
        executeJob = createJob({
          tenantId: job.tenantId,
          kind: job.kind,
          phase: "execute",
          projectId: job.projectId,
          repo: job.repo,
          commands: { execute: executeCommand },
          context: job.context,
          params: nextParams,
        });
      }
      job.planStatus = status;
      job.updatedAt = nowIso();
      json(res, 200, { plan: job, executeJob });
      return;
    }
  }

  error(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`[vibe-bridge] api listening on ${PORT}`);
});
