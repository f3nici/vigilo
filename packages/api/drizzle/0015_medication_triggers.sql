-- Phase 7 companion to 0014, for the same reason as 0008, 0010 and 0012: the
-- generated migration cannot know about the revision trigger, and a syncable
-- table without one keeps revision 0 for ever, which means a device is never
-- told the row changed.

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'medications',
    'medication_schedules',
    'medication_doses',
    'medication_administrations'
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

-- "Full audit trail, no deletion" (doc 01 §7.2). A sign-off is a statement
-- that a medication did or did not reach a person, and there is no version of
-- this product where deleting one is the right answer. UPDATE stays: a PRN
-- outcome is added once it is known, and the revision trigger writes on every
-- change.
REVOKE DELETE ON medication_administrations FROM vigilo_app;
