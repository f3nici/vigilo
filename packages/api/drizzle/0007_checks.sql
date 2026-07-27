CREATE TYPE "public"."coverage_effect" AS ENUM('covered', 'not_covered');--> statement-breakpoint
CREATE TYPE "public"."check_entry_status" AS ENUM('partial', 'complete');--> statement-breakpoint
CREATE TYPE "public"."check_schedule_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."check_template_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."check_version_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."check_window_status" AS ENUM('pending', 'partial', 'complete', 'missed', 'not_expected');--> statement-breakpoint
CREATE TABLE "check_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"window_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "check_entry_status" DEFAULT 'partial' NOT NULL,
	"is_late" boolean DEFAULT false NOT NULL,
	"device_id" uuid,
	"edited_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "check_entries_window_key" UNIQUE("window_id")
);
--> statement-breakpoint
CREATE TABLE "check_entry_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"values_enc" "bytea" NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "check_entry_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value_number" numeric,
	"value_bool" boolean,
	"value_text_enc" "bytea",
	"value_json" jsonb,
	"unit" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "check_entry_values_field_key" UNIQUE("entry_id","field_key")
);
--> statement-breakpoint
CREATE TABLE "check_schedule_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"label" text,
	"window_minutes" integer DEFAULT 120 NOT NULL,
	"anchor_time" time NOT NULL,
	"applies_from_time" time NOT NULL,
	"applies_to_time" time NOT NULL,
	"weekdays" smallint[],
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "segments_window_minutes_sane" CHECK ("check_schedule_segments"."window_minutes" between 5 and 1440)
);
--> statement-breakpoint
CREATE TABLE "check_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active_from" date NOT NULL,
	"active_to" date,
	"status" "check_schedule_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"status" "check_version_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "check_template_versions_number_key" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "check_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "check_template_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"segment_id" uuid,
	"template_version_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"expected" boolean DEFAULT true NOT NULL,
	"coverage_reason" text,
	"status" "check_window_status" DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"is_late" boolean DEFAULT false NOT NULL,
	"late_by_minutes" integer,
	"recalculated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "check_windows_grid_key" UNIQUE("schedule_id","starts_at","segment_id")
);
--> statement-breakpoint
CREATE TABLE "coverage_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"effect" "coverage_effect" NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "coverage_exceptions_ends_after_start" CHECK ("coverage_exceptions"."ends_at" > "coverage_exceptions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "coverage_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"active_from" date NOT NULL,
	"active_to" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "coverage_patterns_weekday_range" CHECK ("coverage_patterns"."weekday" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "missed_reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"requires_note" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "missed_reason_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "window_miss_reasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"window_id" uuid NOT NULL,
	"reason_code_id" uuid NOT NULL,
	"note_enc" "bytea",
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "window_miss_reasons_window_key" UNIQUE("window_id")
);
--> statement-breakpoint
ALTER TABLE "check_entries" ADD CONSTRAINT "check_entries_window_id_check_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."check_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entries" ADD CONSTRAINT "check_entries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entries" ADD CONSTRAINT "check_entries_template_version_id_check_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."check_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entries" ADD CONSTRAINT "check_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entry_revisions" ADD CONSTRAINT "check_entry_revisions_entry_id_check_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."check_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entry_revisions" ADD CONSTRAINT "check_entry_revisions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entry_values" ADD CONSTRAINT "check_entry_values_entry_id_check_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."check_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_entry_values" ADD CONSTRAINT "check_entry_values_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_schedule_segments" ADD CONSTRAINT "check_schedule_segments_schedule_id_check_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."check_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_schedules" ADD CONSTRAINT "check_schedules_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_schedules" ADD CONSTRAINT "check_schedules_template_id_check_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."check_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_schedules" ADD CONSTRAINT "check_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_template_versions" ADD CONSTRAINT "check_template_versions_template_id_check_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."check_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_template_versions" ADD CONSTRAINT "check_template_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_templates" ADD CONSTRAINT "check_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_windows" ADD CONSTRAINT "check_windows_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_windows" ADD CONSTRAINT "check_windows_schedule_id_check_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."check_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_windows" ADD CONSTRAINT "check_windows_segment_id_check_schedule_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."check_schedule_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_windows" ADD CONSTRAINT "check_windows_template_version_id_check_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."check_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_exceptions" ADD CONSTRAINT "coverage_exceptions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_exceptions" ADD CONSTRAINT "coverage_exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_patterns" ADD CONSTRAINT "coverage_patterns_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_patterns" ADD CONSTRAINT "coverage_patterns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_miss_reasons" ADD CONSTRAINT "window_miss_reasons_window_id_check_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."check_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_miss_reasons" ADD CONSTRAINT "window_miss_reasons_reason_code_id_missed_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."missed_reason_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_miss_reasons" ADD CONSTRAINT "window_miss_reasons_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_entries_participant_idx" ON "check_entries" USING btree ("participant_id","recorded_at");--> statement-breakpoint
CREATE INDEX "check_entries_revision_idx" ON "check_entries" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_entry_revisions_entry_idx" ON "check_entry_revisions" USING btree ("entry_id","changed_at");--> statement-breakpoint
CREATE INDEX "check_entry_values_entry_idx" ON "check_entry_values" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "check_entry_values_revision_idx" ON "check_entry_values" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_schedule_segments_schedule_idx" ON "check_schedule_segments" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "check_schedule_segments_revision_idx" ON "check_schedule_segments" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_schedules_participant_idx" ON "check_schedules" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "check_schedules_status_idx" ON "check_schedules" USING btree ("status");--> statement-breakpoint
CREATE INDEX "check_schedules_revision_idx" ON "check_schedules" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_template_versions_template_idx" ON "check_template_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "check_template_versions_revision_idx" ON "check_template_versions" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_templates_status_idx" ON "check_templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "check_templates_revision_idx" ON "check_templates" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "check_windows_participant_idx" ON "check_windows" USING btree ("participant_id","starts_at");--> statement-breakpoint
CREATE INDEX "check_windows_closer_idx" ON "check_windows" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "check_windows_revision_idx" ON "check_windows" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "coverage_exceptions_participant_idx" ON "coverage_exceptions" USING btree ("participant_id","starts_at");--> statement-breakpoint
CREATE INDEX "coverage_exceptions_revision_idx" ON "coverage_exceptions" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "coverage_patterns_participant_idx" ON "coverage_patterns" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "coverage_patterns_revision_idx" ON "coverage_patterns" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "missed_reason_codes_revision_idx" ON "missed_reason_codes" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "window_miss_reasons_revision_idx" ON "window_miss_reasons" USING btree ("revision");