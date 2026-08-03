-- Which check forms belong to which participant (D94).
--
-- Recording a check on demand offered every published form in the org. For a
-- team with a bowel chart, a seizure record, a blood sugar and a blood
-- pressure, a worker picking one for somebody who only ever needs the seizure
-- record has three chances to file an observation on the wrong form, and the
-- list gets longer every time the org writes another one.
--
-- An admin now ticks the forms that apply to each person. This is not a
-- permission and not a schedule: it is what the picker offers.

CREATE TABLE IF NOT EXISTS "participant_check_forms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "participant_id" uuid NOT NULL REFERENCES "participants"("id") ON DELETE cascade,
  "template_id" uuid NOT NULL REFERENCES "check_templates"("id") ON DELETE cascade,
  "assigned_by" uuid REFERENCES "users"("id"),
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revision" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "participant_check_forms_key" UNIQUE ("participant_id", "template_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "participant_check_forms_participant_idx"
  ON "participant_check_forms" ("participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participant_check_forms_revision_idx"
  ON "participant_check_forms" ("revision");--> statement-breakpoint

DROP TRIGGER IF EXISTS "participant_check_forms_set_revision" ON "participant_check_forms";--> statement-breakpoint
CREATE TRIGGER "participant_check_forms_set_revision"
  BEFORE INSERT OR UPDATE ON "participant_check_forms"
  FOR EACH ROW EXECUTE FUNCTION vigilo_set_revision();--> statement-breakpoint

-- Everybody gets everything that exists today.
--
-- The alternative is an empty table, which reads as "no participant has any
-- forms" and silently takes on-demand recording away from every worker in the
-- org until an admin has been through every person. Starting from the current
-- behaviour and letting an admin untick is the same destination without the
-- outage in the middle.
INSERT INTO "participant_check_forms" ("participant_id", "template_id")
SELECT p."id", t."id"
FROM "participants" p
CROSS JOIN "check_templates" t
WHERE t."status" = 'active'
ON CONFLICT ON CONSTRAINT "participant_check_forms_key" DO NOTHING;
