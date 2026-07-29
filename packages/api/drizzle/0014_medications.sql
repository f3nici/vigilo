CREATE TYPE "public"."medication_administration_status" AS ENUM('given', 'refused', 'withheld', 'not_required', 'self_administered');--> statement-breakpoint
CREATE TYPE "public"."medication_dose_status" AS ENUM('pending', 'given', 'refused', 'withheld', 'not_required', 'self_administered', 'missed');--> statement-breakpoint
CREATE TABLE "medication_administrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dose_id" uuid,
	"medication_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"status" "medication_administration_status" NOT NULL,
	"administered_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note_enc" "bytea",
	"reason_enc" "bytea",
	"outcome_enc" "bytea",
	"is_late" boolean DEFAULT false NOT NULL,
	"recorded_by" uuid,
	"witnessed_by" uuid,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_doses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"medication_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"schedule_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"expected" boolean DEFAULT true NOT NULL,
	"coverage_reason" text,
	"status" "medication_dose_status" DEFAULT 'pending' NOT NULL,
	"is_late" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "medication_doses_grid_key" UNIQUE("medication_id","due_at")
);
--> statement-breakpoint
CREATE TABLE "medication_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"medication_id" uuid NOT NULL,
	"time_of_day" time NOT NULL,
	"weekdays" smallint[],
	"active_from" date,
	"active_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"form" text,
	"dose" text NOT NULL,
	"route" text,
	"instructions_enc" "bytea",
	"is_prn" boolean DEFAULT false NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"requires_witness" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "medication_grace_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_dose_id_medication_doses_id_fk" FOREIGN KEY ("dose_id") REFERENCES "public"."medication_doses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_witnessed_by_users_id_fk" FOREIGN KEY ("witnessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_doses" ADD CONSTRAINT "medication_doses_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_doses" ADD CONSTRAINT "medication_doses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_doses" ADD CONSTRAINT "medication_doses_schedule_id_medication_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."medication_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_schedules" ADD CONSTRAINT "medication_schedules_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medications" ADD CONSTRAINT "medications_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medications" ADD CONSTRAINT "medications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_administrations_dose_key" ON "medication_administrations" USING btree ("dose_id") WHERE "medication_administrations"."dose_id" is not null;--> statement-breakpoint
CREATE INDEX "medication_administrations_participant_idx" ON "medication_administrations" USING btree ("participant_id","administered_at");--> statement-breakpoint
CREATE INDEX "medication_administrations_medication_idx" ON "medication_administrations" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "medication_administrations_revision_idx" ON "medication_administrations" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "medication_doses_participant_idx" ON "medication_doses" USING btree ("participant_id","due_at");--> statement-breakpoint
CREATE INDEX "medication_doses_closer_idx" ON "medication_doses" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "medication_doses_revision_idx" ON "medication_doses" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "medication_schedules_medication_idx" ON "medication_schedules" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "medication_schedules_revision_idx" ON "medication_schedules" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "medications_participant_idx" ON "medications" USING btree ("participant_id","active");--> statement-breakpoint
CREATE INDEX "medications_revision_idx" ON "medications" USING btree ("revision");