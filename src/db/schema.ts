import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    phase: text("phase"),
    projectId: text("project_id"),
    repo: jsonb("repo"),
    commands: jsonb("commands"),
    planOutputPath: text("plan_output_path"),
    context: text("context"),
    params: jsonb("params").notNull(),
    idempotencyKey: text("idempotency_key"),
    timeoutSec: integer("timeout_sec"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseAttempt: integer("lease_attempt"),
    result: jsonb("result"),
    resultStatus: text("result_status"),
    planStatus: text("plan_status"),
    planText: text("plan_text"),
    planTruncated: boolean("plan_truncated"),
  },
  (table) => ({
    stateIdx: index("jobs_state_idx").on(table.state),
    tenantStateIdx: index("jobs_tenant_state_idx").on(table.tenantId, table.state),
    requestedIdx: index("jobs_requested_at_idx").on(table.requestedAt),
    updatedIdx: index("jobs_updated_at_idx").on(table.updatedAt),
    leaseIdx: index("jobs_lease_until_idx").on(table.leaseUntil),
  }),
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    sequence: integer("sequence"),
    data: jsonb("data"),
  },
  (table) => ({
    jobIdx: index("job_events_job_id_idx").on(table.jobId),
    createdIdx: index("job_events_created_at_idx").on(table.createdAt),
  }),
);

export const vibeBridgePlans = pgTable(
  "vibe_bridge_plans",
  {
    jobId: text("job_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id"),
    planText: text("plan_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    tenantIdx: index("vibe_bridge_plans_tenant_idx").on(table.tenantId),
  }),
);
