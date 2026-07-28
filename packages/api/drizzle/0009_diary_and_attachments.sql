CREATE TYPE "public"."attachment_owner_type" AS ENUM('diary_entry', 'incident', 'participant_photo');--> statement-breakpoint
CREATE TYPE "public"."attachment_upload_state" AS ENUM('pending', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."diary_category_colour" AS ENUM('lavender', 'sky', 'teal', 'sage', 'sand', 'peach', 'rose', 'slate');--> statement-breakpoint
CREATE TYPE "public"."diary_revision_field" AS ENUM('body', 'category', 'occurred_at', 'visibility');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" "attachment_owner_type" NOT NULL,
	"owner_id" uuid,
	"participant_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text,
	"storage_path" text,
	"thumbnail_path" text,
	"encryption_key_enc" "bytea",
	"width" integer,
	"height" integer,
	"uploaded_by" uuid,
	"upload_state" "attachment_upload_state" DEFAULT 'pending' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"colour" "diary_category_colour" DEFAULT 'slate' NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "diary_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "diary_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"participant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"body_enc" "bytea" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visible_to_participant" boolean DEFAULT true NOT NULL,
	"device_id" uuid,
	"edited_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_entry_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"field" "diary_revision_field" NOT NULL,
	"values_enc" "bytea" NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_category_id_diary_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."diary_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entry_revisions" ADD CONSTRAINT "diary_entry_revisions_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entry_revisions" ADD CONSTRAINT "diary_entry_revisions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "attachments_participant_idx" ON "attachments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "attachments_revision_idx" ON "attachments" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "diary_categories_revision_idx" ON "diary_categories" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "diary_entries_participant_idx" ON "diary_entries" USING btree ("participant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "diary_entries_revision_idx" ON "diary_entries" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "diary_entry_revisions_entry_idx" ON "diary_entry_revisions" USING btree ("entry_id","changed_at");