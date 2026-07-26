CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"org_name" text NOT NULL,
	"timezone" text DEFAULT 'Australia/Melbourne' NOT NULL,
	"retention_years" smallint DEFAULT 7 NOT NULL,
	"late_entry_cutoff_minutes" integer DEFAULT 1440 NOT NULL,
	"window_warning_minutes" integer DEFAULT 20 NOT NULL,
	"escalation_delay_minutes" integer DEFAULT 30 NOT NULL,
	"session_idle_minutes_web" integer DEFAULT 60 NOT NULL,
	"session_idle_minutes_mobile" integer DEFAULT 720 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_settings_single_row" CHECK ("org_settings"."id" = 1)
);
