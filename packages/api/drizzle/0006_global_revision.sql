-- One global revision sequence, fed by a trigger (doc 03, conventions).
--
-- `revision` is what sync cursors walk in Phase 5. A device asks for everything
-- changed after revision N across every table at once, so the numbers have to
-- be monotonic across tables, not per row. Phase 1 incremented a per-row
-- counter, which cannot answer that question.
--
-- The trigger owns the column. Nothing in the application sets it, and the
-- column default of 0 is never the value that lands.

CREATE SEQUENCE IF NOT EXISTS global_revision_seq;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE global_revision_seq TO vigilo_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION vigilo_set_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.revision := nextval('global_revision_seq');
  RETURN NEW;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'users',
    'participants',
    'participant_assignments',
    'participant_alerts',
    'emergency_contacts',
    'emergency_plans',
    'sync_scope_changes'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', syncable || '_set_revision', syncable);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION vigilo_set_revision()',
      syncable || '_set_revision',
      syncable
    );
  END LOOP;
END;
$$;--> statement-breakpoint

-- Existing rows carry revision 0 from Phase 1, which would make them invisible
-- to a cursor. A no-op update fires the trigger and gives them real numbers.
UPDATE users SET updated_at = updated_at;--> statement-breakpoint
UPDATE participant_assignments SET granted_at = granted_at;
