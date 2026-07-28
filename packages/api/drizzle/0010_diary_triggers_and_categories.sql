-- Phase 4 companion to 0009: the revision triggers the generated migration
-- cannot know about, and the diary categories the system ships with.
--
-- Same reasoning as 0008. A syncable table without this trigger keeps revision
-- 0 forever and is invisible to a sync cursor, which only shows up in Phase 5
-- on a device nobody can attach a debugger to.

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'diary_categories',
    'diary_entries',
    'attachments'
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

-- diary_entry_revisions is deliberately absent from that list, like
-- check_entry_revisions before it. It is an append-only history table: nothing
-- updates it, so it carries no revision column to bump.

-- The starting categories from doc 01 §6. An admin can relabel, recolour,
-- reorder or deactivate these and add their own, so they are seeded rather
-- than hard-coded anywhere in the app. Deactivating rather than deleting is
-- what keeps an old entry filed under the category it was written against.
INSERT INTO diary_categories (slug, label, colour, sort_order)
VALUES
  ('personal_care', 'Personal care', 'sky', 10),
  ('behaviour', 'Behaviour', 'peach', 20),
  ('activity', 'Activity', 'sage', 30),
  ('medical', 'Medical', 'rose', 40),
  ('communication', 'Communication', 'lavender', 50),
  ('family_contact', 'Family contact', 'teal', 60),
  ('equipment', 'Equipment', 'sand', 70),
  ('other', 'Other', 'slate', 80)
ON CONFLICT (slug) DO NOTHING;
