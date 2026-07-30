CREATE TYPE "public"."care_plan_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."care_plan_version_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('low', 'moderate', 'high');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'under_review', 'closed');--> statement-breakpoint
CREATE TABLE "care_plan_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"care_plan_version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_plan_reads_once" UNIQUE("care_plan_version_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "care_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"care_plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_enc" "bytea",
	"status" "care_plan_version_status" DEFAULT 'draft' NOT NULL,
	"change_summary" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "care_plan_versions_number_key" UNIQUE("care_plan_id","version")
);
--> statement-breakpoint
CREATE TABLE "care_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "care_plan_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"action_enc" "bytea" NOT NULL,
	"assigned_to" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"note_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"participant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"reported_by" uuid,
	"summary_enc" "bytea" NOT NULL,
	"detail_enc" "bytea" NOT NULL,
	"immediate_action_enc" "bytea" NOT NULL,
	"injuries_enc" "bytea",
	"involved_enc" "bytea",
	"severity" "incident_severity" NOT NULL,
	"family_notified_at" timestamp with time zone,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"closure_notes_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_plan_reads" ADD CONSTRAINT "care_plan_reads_care_plan_version_id_care_plan_versions_id_fk" FOREIGN KEY ("care_plan_version_id") REFERENCES "public"."care_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_reads" ADD CONSTRAINT "care_plan_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_versions" ADD CONSTRAINT "care_plan_versions_care_plan_id_care_plans_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_versions" ADD CONSTRAINT "care_plan_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_plan_reads_user_idx" ON "care_plan_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "care_plan_versions_plan_idx" ON "care_plan_versions" USING btree ("care_plan_id");--> statement-breakpoint
CREATE INDEX "care_plan_versions_revision_idx" ON "care_plan_versions" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "care_plans_participant_idx" ON "care_plans" USING btree ("participant_id","status");--> statement-breakpoint
CREATE INDEX "care_plans_revision_idx" ON "care_plans" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "incident_actions_incident_idx" ON "incident_actions" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incident_actions_assignee_idx" ON "incident_actions" USING btree ("assigned_to","completed_at");--> statement-breakpoint
CREATE INDEX "incident_actions_revision_idx" ON "incident_actions" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "incidents_participant_idx" ON "incidents" USING btree ("participant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incidents_revision_idx" ON "incidents" USING btree ("revision");