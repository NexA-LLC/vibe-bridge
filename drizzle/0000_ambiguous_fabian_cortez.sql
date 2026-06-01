CREATE TABLE IF NOT EXISTS "job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sequence" integer,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"phase" text,
	"project_id" text,
	"repo" jsonb,
	"commands" jsonb,
	"plan_output_path" text,
	"context" text,
	"params" jsonb NOT NULL,
	"idempotency_key" text,
	"timeout_sec" integer,
	"requested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_attempt" integer,
	"result" jsonb,
	"result_status" text,
	"plan_status" text,
	"plan_text" text,
	"plan_truncated" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibe_bridge_plans" (
	"job_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text,
	"plan_text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_job_id_idx" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_created_at_idx" ON "job_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_state_idx" ON "jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_tenant_state_idx" ON "jobs" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_requested_at_idx" ON "jobs" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_updated_at_idx" ON "jobs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_lease_until_idx" ON "jobs" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vibe_bridge_plans_tenant_idx" ON "vibe_bridge_plans" USING btree ("tenant_id");