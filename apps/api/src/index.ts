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

const html = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
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

const DEV_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vibe Bridge Dev UI</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 0; }
      header { padding: 16px 20px; border-bottom: 1px solid rgba(127,127,127,.25); }
      main { padding: 16px 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
      h1 { font-size: 18px; margin: 0; }
      h2 { font-size: 14px; margin: 0 0 10px; }
      .grid { display: grid; gap: 12px; }
      .card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 14px; background: rgba(127,127,127,.06); }
      label { font-size: 12px; display: grid; gap: 6px; }
      input, select, textarea, button { font: inherit; }
      input, select, textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; }
      textarea { min-height: 90px; resize: vertical; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; }
      button { padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.12); cursor: pointer; }
      button.primary { background: rgba(0, 120, 255, .22); border-color: rgba(0, 120, 255, .45); }
      button.danger { background: rgba(255, 80, 80, .18); border-color: rgba(255, 80, 80, .45); }
      button:disabled { opacity: .6; cursor: not-allowed; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { padding: 8px; border-bottom: 1px solid rgba(127,127,127,.25); text-align: left; vertical-align: top; }
      tr:hover td { background: rgba(127,127,127,.10); }
      a { color: inherit; }
      pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
      .muted { opacity: .75; }
      .error { color: #d33; }
      .ok { color: #2a7; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    </style>
  </head>
  <body>
    <header>
      <h1>Vibe Bridge Dev UI</h1>
      <div class="muted" style="margin-top:6px;font-size:12px;">
        Create jobs, watch runner events, and approve plan jobs.
      </div>
    </header>
    <main>
      <section class="card">
        <h2>Connection</h2>
        <div class="row">
          <label>API Base URL
            <input id="apiBase" placeholder="http://127.0.0.1:3900" />
          </label>
          <label>API Token (Bearer)
            <input id="apiToken" placeholder="dev (optional)" />
          </label>
        </div>
        <div class="btns" style="margin-top:10px;">
          <button id="saveConn" class="primary">Save</button>
          <button id="refreshJobs">Refresh jobs</button>
          <label style="display:flex;align-items:center;gap:8px;margin-left:auto;">
            <input id="autoRefresh" type="checkbox" style="width:auto;" />
            <span style="font-size:12px;">Auto refresh (2s)</span>
          </label>
        </div>
        <div id="connStatus" class="muted" style="margin-top:8px;font-size:12px;"></div>
      </section>

      <section class="card">
        <h2>Create Job</h2>
        <div class="row3">
          <label>Tenant
            <input id="tenantId" value="default" />
          </label>
          <label>Kind
            <select id="kind">
              <option value="cli">cli</option>
              <option value="mcp">mcp</option>
              <option value="vibeKanban">vibeKanban</option>
              <option value="vibeKanban.mcp">vibeKanban.mcp</option>
              <option value="brain">brain</option>
            </select>
          </label>
          <label>Phase
            <select id="phase">
              <option value="execute">execute</option>
              <option value="plan">plan</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top:12px;">
          <label>Plan command (optional)
            <textarea id="planCommand" class="mono" placeholder="e.g. echo plan"></textarea>
          </label>
          <label>Execute command (optional)
            <textarea id="executeCommand" class="mono" placeholder="e.g. echo hello"></textarea>
          </label>
        </div>
        <div class="row" style="margin-top:12px;">
          <label>Repo URL (optional)
            <input id="repoUrl" placeholder="https://github.com/org/repo.git" />
          </label>
          <label>Repo ref (optional)
            <input id="repoRef" placeholder="main" />
          </label>
        </div>
        <div class="row" style="margin-top:12px;">
          <label>Repo subdir (optional)
            <input id="repoSubdir" placeholder="path/inside/repo" />
          </label>
          <label>Callback URL (optional, runner best-effort)
            <input id="callbackUrl" placeholder="http://127.0.0.1:9999/webhook" />
          </label>
        </div>
        <label style="margin-top:12px;">Params JSON
          <textarea id="params" class="mono" placeholder='{}'>{}</textarea>
        </label>
        <div class="btns" style="margin-top:10px;">
          <button id="fillEcho">Fill: echo</button>
          <button id="createJob" class="primary">Create job</button>
        </div>
        <div id="createStatus" class="muted" style="margin-top:8px;font-size:12px;"></div>
      </section>

      <section class="card">
        <h2>Jobs</h2>
        <div class="muted" style="font-size:12px;margin-bottom:8px;">Click a row to load details.</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>State</th>
              <th>Kind</th>
              <th>Phase</th>
              <th>Tenant</th>
              <th>Updated</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody id="jobsTbody"></tbody>
        </table>
      </section>

      <section class="card">
        <h2>Job Detail</h2>
        <div id="jobActions" class="btns" style="margin-bottom:10px;display:none;">
          <button id="approvePlan" class="primary">Approve plan (spawn execute)</button>
          <button id="rejectPlan" class="danger">Reject plan</button>
        </div>
        <div id="jobMeta" class="muted" style="font-size:12px;margin-bottom:8px;"></div>
        <pre id="jobDetail" class="mono"></pre>
      </section>
    </main>
    <script>
      const storage = {
        get(key, fallback) {
          try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
        },
        set(key, value) {
          try { localStorage.setItem(key, value); } catch {}
        },
      };

      const state = {
        apiBase: storage.get("vb_api_base", location.origin),
        apiToken: storage.get("vb_api_token", ""),
        selectedJobId: null,
        autoRefresh: storage.get("vb_auto_refresh", "0") === "1",
        timer: null,
      };

      const $ = (id) => document.getElementById(id);

      const connStatusEl = $("connStatus");
      const createStatusEl = $("createStatus");
      const jobsTbodyEl = $("jobsTbody");
      const jobDetailEl = $("jobDetail");
      const jobMetaEl = $("jobMeta");
      const jobActionsEl = $("jobActions");

      const setStatus = (el, text, kind) => {
        el.textContent = text;
        el.classList.remove("error", "ok");
        if (kind) el.classList.add(kind);
      };

      const authHeaders = () => {
        const headers = {};
        if (state.apiToken && state.apiToken.trim()) headers["Authorization"] = \`Bearer \${state.apiToken.trim()}\`;
        return headers;
      };

      const apiFetch = async (path, init = {}) => {
        const url = new URL(path, state.apiBase);
        const headers = { ...authHeaders(), ...(init.headers || {}) };
        const res = await fetch(url.toString(), { ...init, headers });
        const raw = await res.text();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        if (!res.ok) {
          const msg = parsed && parsed.error ? parsed.error : raw || \`HTTP \${res.status}\`;
          throw new Error(msg);
        }
        return parsed;
      };

      const parseJsonOrThrow = (text) => {
        const trimmed = (text || "").trim();
        if (!trimmed) return {};
        try {
          const parsed = JSON.parse(trimmed);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Params must be an object");
          return parsed;
        } catch (e) {
          throw new Error(\`Invalid JSON: \${e && e.message ? e.message : String(e)}\`);
        }
      };

      const saveConn = () => {
        state.apiBase = ($("apiBase").value || "").trim() || location.origin;
        state.apiToken = ($("apiToken").value || "").trim();
        storage.set("vb_api_base", state.apiBase);
        storage.set("vb_api_token", state.apiToken);
        setStatus(connStatusEl, \`Saved. Using \${state.apiBase}\`, "ok");
      };

      const renderJobs = (jobs) => {
        jobsTbodyEl.textContent = "";
        for (const job of jobs) {
          const tr = document.createElement("tr");
          tr.style.cursor = "pointer";
          tr.addEventListener("click", () => loadJob(job.id));
          const cells = [
            job.id,
            job.state,
            job.kind,
            job.phase || "",
            job.tenantId,
            job.updatedAt,
            job.resultStatus || "",
          ];
          for (const cell of cells) {
            const td = document.createElement("td");
            td.textContent = String(cell ?? "");
            tr.appendChild(td);
          }
          jobsTbodyEl.appendChild(tr);
        }
      };

      const refreshJobs = async () => {
        try {
          setStatus(connStatusEl, "Refreshing jobs...", null);
          const data = await apiFetch("/jobs?limit=200");
          renderJobs((data && data.jobs) || []);
          setStatus(connStatusEl, \`Loaded \${((data && data.jobs) || []).length} jobs\`, "ok");
        } catch (e) {
          setStatus(connStatusEl, e.message || String(e), "error");
        }
      };

      const updateJobActions = (job) => {
        if (!job || job.phase !== "plan" || !job.planStatus || job.planStatus !== "pending") {
          jobActionsEl.style.display = "none";
          return;
        }
        jobActionsEl.style.display = "flex";
      };

      const loadJob = async (id) => {
        state.selectedJobId = id;
        try {
          const job = await apiFetch(\`/jobs/\${encodeURIComponent(id)}\`);
          updateJobActions(job);
          const meta = [
            \`id=\${job.id}\`,
            \`state=\${job.state}\`,
            \`kind=\${job.kind}\`,
            \`phase=\${job.phase || ""}\`,
            \`tenant=\${job.tenantId}\`,
            job.planStatus ? \`planStatus=\${job.planStatus}\` : null,
          ].filter(Boolean).join("  ");
          jobMetaEl.textContent = meta;
          jobDetailEl.textContent = JSON.stringify(job, null, 2);
        } catch (e) {
          jobMetaEl.textContent = "";
          jobDetailEl.textContent = "";
          setStatus(connStatusEl, e.message || String(e), "error");
        }
      };

      const createJob = async () => {
        try {
          setStatus(createStatusEl, "Creating...", null);
          const tenantId = ($("tenantId").value || "").trim() || "default";
          const kind = $("kind").value;
          const phase = $("phase").value;
          const planCommand = ($("planCommand").value || "").trim();
          const executeCommand = ($("executeCommand").value || "").trim();
          const repoUrl = ($("repoUrl").value || "").trim();
          const repoRef = ($("repoRef").value || "").trim();
          const repoSubdir = ($("repoSubdir").value || "").trim();
          const callbackUrl = ($("callbackUrl").value || "").trim();
          const params = parseJsonOrThrow($("params").value);

          if (callbackUrl) {
            params.callback = { url: callbackUrl };
          }

          const commands = {};
          if (planCommand) commands.plan = planCommand;
          if (executeCommand) commands.execute = executeCommand;

          const payload = {
            tenantId,
            kind,
            phase,
            commands: Object.keys(commands).length ? commands : undefined,
            repo: repoUrl ? { url: repoUrl, ref: repoRef || undefined, subdir: repoSubdir || undefined } : undefined,
            params,
          };

          const created = await apiFetch("/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setStatus(createStatusEl, \`Created job \${created.id}\`, "ok");
          await refreshJobs();
          await loadJob(created.id);
        } catch (e) {
          setStatus(createStatusEl, e.message || String(e), "error");
        }
      };

      const approvePlan = async (approved) => {
        if (!state.selectedJobId) return;
        try {
          setStatus(connStatusEl, approved ? "Approving..." : "Rejecting...", null);
          const executeCommand = ($("executeCommand").value || "").trim();
          const payload = approved
            ? {
                approved: true,
                executeJob: executeCommand ? { commands: { execute: executeCommand } } : undefined,
              }
            : { approved: false };
          const resp = await apiFetch(\`/jobs/\${encodeURIComponent(state.selectedJobId)}/approve\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setStatus(connStatusEl, approved ? "Approved" : "Rejected", "ok");
          await refreshJobs();
          await loadJob(resp.plan.id);
          if (resp.executeJob && resp.executeJob.id) await loadJob(resp.executeJob.id);
        } catch (e) {
          setStatus(connStatusEl, e.message || String(e), "error");
        }
      };

      const setAutoRefresh = (on) => {
        state.autoRefresh = !!on;
        storage.set("vb_auto_refresh", state.autoRefresh ? "1" : "0");
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        if (!state.autoRefresh) return;
        state.timer = setInterval(async () => {
          await refreshJobs();
          if (state.selectedJobId) await loadJob(state.selectedJobId);
        }, 2000);
      };

      $("apiBase").value = state.apiBase;
      $("apiToken").value = state.apiToken;
      $("autoRefresh").checked = state.autoRefresh;

      $("saveConn").addEventListener("click", () => saveConn());
      $("refreshJobs").addEventListener("click", () => refreshJobs());
      $("createJob").addEventListener("click", () => createJob());
      $("fillEcho").addEventListener("click", () => {
        $("kind").value = "cli";
        $("phase").value = "execute";
        $("executeCommand").value = "echo hello";
      });
      $("approvePlan").addEventListener("click", () => approvePlan(true));
      $("rejectPlan").addEventListener("click", () => approvePlan(false));
      $("autoRefresh").addEventListener("change", (e) => setAutoRefresh(e.target.checked));

      saveConn();
      refreshJobs().catch(() => {});
      setAutoRefresh(state.autoRefresh);
    </script>
  </body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    error(res, 400, "Invalid request");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/ui" || pathname === "/ui/")) {
    html(res, 200, DEV_UI_HTML);
    return;
  }

  if (!requireAuth(req, res)) return;

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

  if (req.method === "GET" && pathname === "/jobs") {
    const filters = {
      tenantId: url.searchParams.get("tenantId") || undefined,
      kinds: parseList(url.searchParams.get("kinds")),
      phases: parseList(url.searchParams.get("phases")),
      states: parseList(url.searchParams.get("states")),
    };
    const limit = Math.min(toNumber(url.searchParams.get("limit"), 200), 500);
    const records = Array.from(jobs.values()).filter((job) => {
      if (filters.tenantId && job.tenantId !== filters.tenantId) return false;
      if (filters.kinds && filters.kinds.size > 0 && !filters.kinds.has(job.kind)) return false;
      if (filters.phases && filters.phases.size > 0 && !filters.phases.has(job.phase || "")) return false;
      if (filters.states && filters.states.size > 0 && !filters.states.has(job.state)) return false;
      return true;
    });
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const payload = records.slice(0, limit).map((job) => ({
      id: job.id,
      tenantId: job.tenantId,
      kind: job.kind,
      phase: job.phase || null,
      projectId: job.projectId || null,
      state: job.state,
      requestedAt: job.requestedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      planStatus: job.planStatus || null,
      resultStatus: job.result?.status || null,
      eventsCount: job.events.length,
    }));
    json(res, 200, { jobs: payload });
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
