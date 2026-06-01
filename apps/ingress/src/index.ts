import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { JobSpec } from "@vibe-bridge/shared";
import WebSocket from "ws";

type SourceKind = "webhook" | "slack" | "line" | "sqs" | "websocket";

type EnqueueInput = {
  source: SourceKind;
  payload: unknown;
  sourceMessageId?: string;
  receivedAt?: string;
};

type IngressConfig = {
  apiBaseUrl: string;
  apiToken: string;
  sources: Set<SourceKind>;
  tenantId: string;
  defaultKind: JobSpec["kind"];
  defaultPhase?: JobSpec["phase"];
  defaultAiBackend: string;
  webhookPort: number;
  webhookToken?: string;
  webhookPath: string;
  slackPath: string;
  slackSigningSecret?: string;
  linePath: string;
  lineChannelSecret?: string;
  sqsQueueUrl?: string;
  sqsRegion?: string;
  sqsWaitTimeSec: number;
  sqsVisibilityTimeoutSec?: number;
  sqsMaxMessages: number;
  websocketUrl?: string;
  websocketToken?: string;
  websocketReconnectSec: number;
};

const nowIso = () => new Date().toISOString();

const resolveEnv = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const getNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseSources = (value: string | undefined): Set<SourceKind> => {
  const raw = value || "webhook";
  const allowed = new Set<SourceKind>(["webhook", "slack", "line", "sqs", "websocket"]);
  const out = new Set<SourceKind>();
  for (const item of raw.split(",")) {
    const normalized = item.trim().toLowerCase();
    if (!normalized) continue;
    if (!allowed.has(normalized as SourceKind)) {
      throw new Error(`Unknown ingress source: ${item}`);
    }
    out.add(normalized as SourceKind);
  }
  return out.size > 0 ? out : new Set<SourceKind>(["webhook"]);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const readRawBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendText = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const verifyBearer = (req: IncomingMessage, token?: string): boolean => {
  if (!token) return true;
  const header = req.headers.authorization || "";
  const explicit = req.headers["x-vibe-bridge-token"];
  return header === `Bearer ${token}` || explicit === token;
};

const verifySlackSignature = (req: IncomingMessage, rawBody: string, signingSecret?: string): boolean => {
  if (!signingSecret) return true;
  const timestamp = getString(req.headers["x-slack-request-timestamp"]);
  const signature = getString(req.headers["x-slack-signature"]);
  if (!timestamp || !signature) return false;
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return constantTimeEqual(digest, signature);
};

const verifyLineSignature = (req: IncomingMessage, rawBody: string, channelSecret?: string): boolean => {
  if (!channelSecret) return true;
  const signature = getString(req.headers["x-line-signature"]);
  if (!signature) return false;
  const digest = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  return constantTimeEqual(digest, signature);
};

const parseBody = (rawBody: string, contentType: string | undefined): unknown => {
  if ((contentType || "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  return rawBody.trim() ? safeJsonParse(rawBody) : null;
};

const unwrapEnvelope = (value: unknown): unknown => {
  const record = asRecord(value);
  if (!record) return value;
  if (asRecord(record.job)) return record.job;
  if (typeof record.Message === "string") {
    const parsed = safeJsonParse(record.Message);
    return parsed ?? record.Message;
  }
  if (typeof record.message === "string" && !record.kind && !record.params) {
    const parsed = safeJsonParse(record.message);
    return parsed ?? value;
  }
  return value;
};

const normalizeJobInput = (input: EnqueueInput, config: IngressConfig): Partial<JobSpec> => {
  const unwrapped = unwrapEnvelope(input.payload);
  const record = asRecord(unwrapped);
  const sourceMeta = {
    source: input.source,
    sourceMessageId: input.sourceMessageId,
    receivedAt: input.receivedAt || nowIso(),
  };

  if (record) {
    const jobRecord = asRecord(record.job) ?? record;
    const prompt =
      getString(jobRecord.prompt) ||
      getString(jobRecord.text) ||
      getString(jobRecord.message) ||
      getString(jobRecord.input);
    const params: Record<string, unknown> = {
      ...(asRecord(jobRecord.params) ?? {}),
      vibeBridgeIngress: sourceMeta,
    };
    if (prompt && !params.prompt) params.prompt = prompt;
    if (!params.aiBackend && (jobRecord.kind === "ai" || !jobRecord.kind)) {
      params.aiBackend = getString(jobRecord.aiBackend) || config.defaultAiBackend;
    }

    return {
      id: getString(jobRecord.id),
      tenantId: getString(jobRecord.tenantId) || config.tenantId,
      kind: (getString(jobRecord.kind) as JobSpec["kind"] | undefined) || config.defaultKind,
      phase: (getString(jobRecord.phase) as JobSpec["phase"] | undefined) || config.defaultPhase,
      projectId: getString(jobRecord.projectId),
      repo: asRecord(jobRecord.repo) as unknown as JobSpec["repo"] | undefined,
      commands: asRecord(jobRecord.commands) as unknown as JobSpec["commands"] | undefined,
      planOutputPath: getString(jobRecord.planOutputPath),
      context: getString(jobRecord.context) || prompt,
      params,
      idempotencyKey: getString(jobRecord.idempotencyKey) || input.sourceMessageId,
      timeoutSec: typeof jobRecord.timeoutSec === "number" ? jobRecord.timeoutSec : undefined,
      requestedAt: getString(jobRecord.requestedAt) || nowIso(),
    };
  }

  const text = typeof unwrapped === "string" ? unwrapped.trim() : "";
  if (!text) throw new Error("Ingress payload must be a JobSpec-like object or text prompt");
  return {
    tenantId: config.tenantId,
    kind: config.defaultKind,
    phase: config.defaultPhase,
    context: text,
    params: {
      prompt: text,
      aiBackend: config.defaultAiBackend,
      vibeBridgeIngress: sourceMeta,
    },
    idempotencyKey: input.sourceMessageId,
    requestedAt: nowIso(),
  };
};

const enqueueJob = async (input: EnqueueInput, config: IngressConfig): Promise<JobSpec> => {
  const spec = normalizeJobInput(input, config);
  const response = await fetch(`${config.apiBaseUrl}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
    },
    body: JSON.stringify(spec),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Control plane enqueue failed ${response.status}: ${raw}`);
  }
  return JSON.parse(raw) as JobSpec;
};

const slackJobFromPayload = (payload: unknown, config: IngressConfig): Partial<JobSpec> | null => {
  const record = asRecord(payload);
  if (!record) return null;
  if (record.type === "url_verification") return null;

  const event = asRecord(record.event);
  const text =
    getString(record.text) ||
    getString(event?.text) ||
    getString(asRecord(event?.message)?.text);
  if (!text) return null;
  const teamId = getString(record.team_id) || getString(record.teamId) || getString(asRecord(record.team)?.id);
  const channelId = getString(record.channel_id) || getString(event?.channel);
  const userId = getString(record.user_id) || getString(event?.user);
  return {
    tenantId: teamId || config.tenantId,
    kind: "ai",
    phase: "plan",
    context: text,
    params: {
      prompt: text,
      aiBackend: config.defaultAiBackend,
      slack: { teamId, channelId, userId },
    },
    idempotencyKey:
      getString(record.trigger_id) ||
      getString(event?.client_msg_id) ||
      getString(record.event_id) ||
      `slack_${randomUUID()}`,
    requestedAt: nowIso(),
  };
};

const lineJobsFromPayload = (payload: unknown, config: IngressConfig): Partial<JobSpec>[] => {
  const record = asRecord(payload);
  const events = Array.isArray(record?.events) ? record.events : [];
  const jobs: Partial<JobSpec>[] = [];
  for (const entry of events) {
    const event = asRecord(entry);
    const message = asRecord(event?.message);
    const text = getString(message?.text);
    if (!text) continue;
    const source = asRecord(event?.source);
    jobs.push({
      tenantId: getString(source?.groupId) || getString(source?.userId) || config.tenantId,
      kind: "ai",
      phase: "plan",
      context: text,
      params: {
        prompt: text,
        aiBackend: config.defaultAiBackend,
        line: {
          userId: getString(source?.userId),
          groupId: getString(source?.groupId),
          roomId: getString(source?.roomId),
          replyToken: getString(event?.replyToken),
        },
      },
      idempotencyKey: getString(event?.webhookEventId) || `line_${randomUUID()}`,
      requestedAt: nowIso(),
    });
  }
  return jobs;
};

const handleWebhookRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  config: IngressConfig,
  source: SourceKind,
) => {
  const rawBody = await readRawBody(req);
  if (!verifyBearer(req, config.webhookToken)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  const payload = parseBody(rawBody, req.headers["content-type"]);
  try {
    const job = await enqueueJob({ source, payload, receivedAt: nowIso() }, config);
    sendJson(res, 202, { jobId: job.id });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
};

const handleSlackRequest = async (req: IncomingMessage, res: ServerResponse, config: IngressConfig) => {
  const rawBody = await readRawBody(req);
  if (!verifySlackSignature(req, rawBody, config.slackSigningSecret)) {
    sendJson(res, 401, { error: "Invalid Slack signature" });
    return;
  }
  const payload = parseBody(rawBody, req.headers["content-type"]);
  const challenge = getString(asRecord(payload)?.challenge);
  if (challenge) {
    sendText(res, 200, challenge);
    return;
  }
  const job = slackJobFromPayload(payload, config);
  if (!job) {
    sendJson(res, 202, { ok: true, skipped: true });
    return;
  }
  try {
    const created = await enqueueJob({ source: "slack", payload: job, receivedAt: nowIso() }, config);
    sendJson(res, 202, { ok: true, jobId: created.id });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

const handleLineRequest = async (req: IncomingMessage, res: ServerResponse, config: IngressConfig) => {
  const rawBody = await readRawBody(req);
  if (!verifyLineSignature(req, rawBody, config.lineChannelSecret)) {
    sendJson(res, 401, { error: "Invalid LINE signature" });
    return;
  }
  const payload = parseBody(rawBody, req.headers["content-type"]);
  const jobs = lineJobsFromPayload(payload, config);
  try {
    const created = [];
    for (const job of jobs) {
      created.push(await enqueueJob({ source: "line", payload: job, receivedAt: nowIso() }, config));
    }
    sendJson(res, 202, { ok: true, jobIds: created.map((job) => job.id) });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

const startWebhookServer = (config: IngressConfig) => {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "Invalid request" });
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (url.pathname === config.webhookPath && config.sources.has("webhook")) {
      await handleWebhookRequest(req, res, config, "webhook");
      return;
    }
    if (url.pathname === config.slackPath && config.sources.has("slack")) {
      await handleSlackRequest(req, res, config);
      return;
    }
    if (url.pathname === config.linePath && config.sources.has("line")) {
      await handleLineRequest(req, res, config);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.listen(config.webhookPort, () => {
    console.log(`[vibe-bridge] ingress webhook listening on ${config.webhookPort}`);
  });
};

const parseSqsBody = (message: Message): unknown => {
  if (!message.Body) return null;
  const parsed = safeJsonParse(message.Body);
  return unwrapEnvelope(parsed ?? message.Body);
};

const runSqsLoop = async (config: IngressConfig) => {
  if (!config.sqsQueueUrl) throw new Error("VIBE_BRIDGE_SQS_QUEUE_URL is required for sqs source");
  const client = new SQSClient({ region: config.sqsRegion });
  console.log(`[vibe-bridge] ingress sqs polling ${config.sqsQueueUrl}`);
  while (true) {
    try {
      const received = await client.send(new ReceiveMessageCommand({
        QueueUrl: config.sqsQueueUrl,
        MaxNumberOfMessages: config.sqsMaxMessages,
        WaitTimeSeconds: config.sqsWaitTimeSec,
        VisibilityTimeout: config.sqsVisibilityTimeoutSec,
        MessageAttributeNames: ["All"],
      }));
      for (const message of received.Messages ?? []) {
        const payload = parseSqsBody(message);
        const sourceMessageId = message.MessageId;
        const job = await enqueueJob({ source: "sqs", payload, sourceMessageId, receivedAt: nowIso() }, config);
        console.log(`[vibe-bridge] ingress sqs enqueued ${job.id}`);
        if (message.ReceiptHandle) {
          await client.send(new DeleteMessageCommand({
            QueueUrl: config.sqsQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
        }
      }
    } catch (error) {
      console.error("[vibe-bridge] ingress sqs error", error);
      await delay(5000);
    }
  }
};

const runWebSocketLoop = async (config: IngressConfig) => {
  if (!config.websocketUrl) throw new Error("VIBE_BRIDGE_WS_URL is required for websocket source");
  while (true) {
    await new Promise<void>((resolve) => {
      const headers = config.websocketToken ? { Authorization: `Bearer ${config.websocketToken}` } : undefined;
      const ws = new WebSocket(config.websocketUrl as string, { headers });
      ws.on("open", () => console.log(`[vibe-bridge] ingress websocket connected ${config.websocketUrl}`));
      ws.on("message", (data) => {
        void (async () => {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          const payload = safeJsonParse(text) ?? text;
          const messageId = getString(asRecord(payload)?.id) || getString(asRecord(payload)?.messageId);
          const job = await enqueueJob({
            source: "websocket",
            payload,
            sourceMessageId: messageId,
            receivedAt: nowIso(),
          }, config);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ack", messageId, jobId: job.id }));
          }
        })().catch((error) => {
          console.error("[vibe-bridge] ingress websocket message error", error);
        });
      });
      ws.on("close", () => resolve());
      ws.on("error", (error) => {
        console.error("[vibe-bridge] ingress websocket error", error);
        ws.close();
      });
    });
    await delay(config.websocketReconnectSec * 1000);
  }
};

const loadConfig = (): IngressConfig => {
  const apiBaseUrl = resolveEnv("VIBE_BRIDGE_API_BASE") || "";
  const apiToken = resolveEnv("VIBE_BRIDGE_API_TOKEN") || "";
  if (!apiBaseUrl) throw new Error("VIBE_BRIDGE_API_BASE is required");
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    apiToken,
    sources: parseSources(resolveEnv("VIBE_BRIDGE_INGRESS_SOURCES")),
    tenantId: resolveEnv("VIBE_BRIDGE_INGRESS_TENANT_ID") || "default",
    defaultKind: (resolveEnv("VIBE_BRIDGE_INGRESS_DEFAULT_KIND") as JobSpec["kind"] | undefined) || "ai",
    defaultPhase: (resolveEnv("VIBE_BRIDGE_INGRESS_DEFAULT_PHASE") as JobSpec["phase"] | undefined) || "plan",
    defaultAiBackend: resolveEnv("VIBE_BRIDGE_INGRESS_AI_BACKEND", "VIBE_BRIDGE_AI_BACKEND") || "codex-cli",
    webhookPort: getNumber(resolveEnv("VIBE_BRIDGE_INGRESS_PORT", "INGRESS_PORT"), 3910),
    webhookToken: resolveEnv("VIBE_BRIDGE_INGRESS_TOKEN"),
    webhookPath: resolveEnv("VIBE_BRIDGE_INGRESS_WEBHOOK_PATH") || "/ingress/jobs",
    slackPath: resolveEnv("VIBE_BRIDGE_SLACK_PATH") || "/ingress/slack",
    slackSigningSecret: resolveEnv("SLACK_SIGNING_SECRET", "VIBE_BRIDGE_SLACK_SIGNING_SECRET"),
    linePath: resolveEnv("VIBE_BRIDGE_LINE_PATH") || "/ingress/line",
    lineChannelSecret: resolveEnv("LINE_CHANNEL_SECRET", "VIBE_BRIDGE_LINE_CHANNEL_SECRET"),
    sqsQueueUrl: resolveEnv("VIBE_BRIDGE_SQS_QUEUE_URL"),
    sqsRegion: resolveEnv("AWS_REGION", "AWS_DEFAULT_REGION", "VIBE_BRIDGE_SQS_REGION"),
    sqsWaitTimeSec: getNumber(resolveEnv("VIBE_BRIDGE_SQS_WAIT_TIME_SEC"), 20),
    sqsVisibilityTimeoutSec: resolveEnv("VIBE_BRIDGE_SQS_VISIBILITY_TIMEOUT_SEC")
      ? getNumber(resolveEnv("VIBE_BRIDGE_SQS_VISIBILITY_TIMEOUT_SEC"), 60)
      : undefined,
    sqsMaxMessages: Math.min(getNumber(resolveEnv("VIBE_BRIDGE_SQS_MAX_MESSAGES"), 5), 10),
    websocketUrl: resolveEnv("VIBE_BRIDGE_WS_URL"),
    websocketToken: resolveEnv("VIBE_BRIDGE_WS_TOKEN"),
    websocketReconnectSec: getNumber(resolveEnv("VIBE_BRIDGE_WS_RECONNECT_SEC"), 5),
  };
};

const main = async () => {
  const config = loadConfig();
  if (config.sources.has("webhook") || config.sources.has("slack") || config.sources.has("line")) {
    startWebhookServer(config);
  }
  const loops: Promise<void>[] = [];
  if (config.sources.has("sqs")) loops.push(runSqsLoop(config));
  if (config.sources.has("websocket")) loops.push(runWebSocketLoop(config));
  if (loops.length > 0) await Promise.all(loops);
};

main().catch((error) => {
  console.error("[vibe-bridge] ingress failed", error);
  process.exit(1);
});
