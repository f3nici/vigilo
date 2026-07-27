-- Phase 3 companion to 0007: the revision triggers the generated migration
-- cannot know about, and the reason codes the system ships with.
--
-- Every syncable table added in 0007 joins the one global sequence from 0006.
-- A table without this trigger keeps revision 0 forever and is invisible to a
-- sync cursor, which is the kind of bug that only shows up in Phase 5 on a
-- device nobody can attach a debugger to.

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'check_templates',
    'check_template_versions',
    'check_schedules',
    'check_schedule_segments',
    'coverage_patterns',
    'coverage_exceptions',
    'check_windows',
    'check_entries',
    'check_entry_values',
    'missed_reason_codes',
    'window_miss_reasons'
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

-- check_entry_revisions is deliberately absent from that list. It is an
-- append-only history table, like the audit log: nothing updates it, so it
-- carries no revision column to bump.

-- The starting reason codes from doc 03 §6. An admin can relabel, deactivate or
-- add to these, so they are seeded rather than hard-coded anywhere in the app.
-- "other" requires a note, because a reason of "other" with no note records
-- nothing at all.
INSERT INTO missed_reason_codes (code, label, requires_note, sort_order)
VALUES
  ('asleep', 'Participant was asleep', false, 10),
  ('refused', 'Participant refused', false, 20),
  ('not_home', 'Participant was not home', false, 30),
  ('staff_emergency', 'Staff attending an emergency', false, 40),
  ('equipment_unavailable', 'Equipment unavailable', false, 50),
  ('family_supporting', 'Family was supporting', false, 60),
  ('forgot', 'Forgot to record it', false, 70),
  ('other', 'Something else', true, 80)
ON CONFLICT (code) DO NOTHING;
