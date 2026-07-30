-- Phase 8 companion to 0016, for the same reason as every companion before it:
-- the generated migration cannot know about the revision trigger, and a
-- syncable table without one keeps revision 0 for ever, so a device is never
-- told the row changed.
--
-- `care_plan_reads` has no revision and no trigger. It is not data a device
-- holds: a phone needs to know whether *it* has read the current version, and
-- that travels as a flag on the plan itself.

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'care_plans',
    'care_plan_versions',
    'incidents',
    'incident_actions'
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

-- An incident is a record of something that happened to a person, and there is
-- no version of this product where deleting one is the right answer. Its
-- follow-up actions go with it: an action added by mistake is completed with a
-- note saying so, which leaves a record, rather than vanishing.
--
-- A care plan version keeps its DELETE grant on purpose. An unpublished draft
-- is not a record of care, and discarding one is a normal thing for an author
-- to do. The service refuses to delete anything published.
REVOKE DELETE ON incidents FROM vigilo_app;--> statement-breakpoint
REVOKE DELETE ON incident_actions FROM vigilo_app;
