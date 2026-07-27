-- The participant record itself (doc 03 §3).
--
-- Phase 1 left this table as a skeleton with nullable name columns, because
-- identity and the scope resolver both had to point at something. The record is
-- real from here, so the identifying columns become NOT NULL, which is only
-- possible while the table is empty. It is empty everywhere: nothing could
-- create a participant before this migration. Say so plainly rather than
-- leaving a bare "contains null values" to interpret.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM participants) THEN
    RAISE EXCEPTION 'participants holds Phase 1 skeleton rows with no name, date of birth or NDIS number. They cannot be filled in automatically. Remove them before deploying this.';
  END IF;
END;
$$;--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('allergy', 'medical', 'behavioural', 'communication', 'other');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."scope_change_effect" AS ENUM('granted', 'revoked');--> statement-breakpoint
CREATE TABLE "emergency_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"name_enc" "bytea" NOT NULL,
	"relationship_enc" "bytea" NOT NULL,
	"phone_primary_enc" "bytea" NOT NULL,
	"phone_secondary_enc" "bytea",
	"email_enc" "bytea",
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"notes_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emergency_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_enc" "bytea" NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "emergency_plans_participant_key" UNIQUE("participant_id")
);
--> statement-breakpoint
CREATE TABLE "participant_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"text_enc" "bytea" NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_scope_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"effect" "scope_change_effect" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "first_name_enc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "last_name_enc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "name_search_bidx" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "preferred_name_enc" "bytea";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "dob_enc" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "ndis_number_enc" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "ndis_number_bidx" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "address_enc" "bytea";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "phone_enc" "bytea";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "email_enc" "bytea";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "notes_enc" "bytea";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_plans" ADD CONSTRAINT "emergency_plans_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_plans" ADD CONSTRAINT "emergency_plans_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_alerts" ADD CONSTRAINT "participant_alerts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_alerts" ADD CONSTRAINT "participant_alerts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_scope_changes" ADD CONSTRAINT "sync_scope_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emergency_contacts_participant_idx" ON "emergency_contacts" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "emergency_contacts_revision_idx" ON "emergency_contacts" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "emergency_plans_revision_idx" ON "emergency_plans" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "participant_alerts_participant_idx" ON "participant_alerts" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "participant_alerts_revision_idx" ON "participant_alerts" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "sync_scope_changes_user_idx" ON "sync_scope_changes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_scope_changes_revision_idx" ON "sync_scope_changes" USING btree ("revision");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_ndis_bidx_key" ON "participants" USING btree ("ndis_number_bidx");--> statement-breakpoint
CREATE INDEX "participants_name_bidx_idx" ON "participants" USING btree ("name_search_bidx");--> statement-breakpoint
CREATE INDEX "participants_status_idx" ON "participants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "participants_revision_idx" ON "participants" USING btree ("revision");