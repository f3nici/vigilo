-- A note added to a recorded check after the fact (D96).
--
-- A check form records what was observed and nothing else, which is the point:
-- it is a form, not a conversation. But somebody looking at a completed
-- observation afterwards often has to say something about it, and until now
-- the only writable surface on a recorded check was the values themselves.
-- Editing a value to explain it destroys the reading; writing the explanation
-- into a free text field on the form only works if the form happens to have
-- one.
--
-- So this is a separate line beside the record rather than part of it. The
-- values stay exactly as the worker recorded them.
--
-- Append-only, and the grant is what enforces that, the same way it does for a
-- medication sign-off and the audit log. A note gets read and acted on, and a
-- note that could be reworded afterwards is not evidence of anything.

CREATE TABLE IF NOT EXISTS "check_entry_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entry_id" uuid NOT NULL REFERENCES "check_entries"("id") ON DELETE cascade,
  -- Free text about a person, so encrypted, like every other note in Vigilo.
  "body_enc" bytea NOT NULL,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "check_entry_notes_entry_idx"
  ON "check_entry_notes" ("entry_id", "created_at");--> statement-breakpoint

REVOKE UPDATE, DELETE ON "check_entry_notes" FROM vigilo_app;
