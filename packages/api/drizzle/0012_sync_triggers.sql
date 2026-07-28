-- Phase 5 companion to 0011.
--
-- Same reasoning as 0008 and 0010: the generated migration cannot know about
-- the revision trigger, and a syncable table without one keeps revision 0
-- forever. A tombstone stuck at revision 0 is worse than the others, because
-- it means a device is never told about a deletion at all.

DO $$
DECLARE
  syncable text;
BEGIN
  FOREACH syncable IN ARRAY ARRAY[
    'sync_deletions'
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

-- sync_applied_ops, push_subscriptions, notification_preferences and
-- notifications_sent carry no revision and no trigger. None of them is data a
-- device holds: the first is the server's own idempotency ledger, and the rest
-- are about a device rather than about a participant.

-- The idempotency ledger is append-only for the same reason the audit log is.
-- An UPDATE here would let a replay be re-applied, and a DELETE would let one
-- be applied twice, which is the exact duplication the table exists to stop.
REVOKE UPDATE, DELETE ON sync_applied_ops FROM vigilo_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION vigilo_sync_applied_ops_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sync_applied_ops is append-only';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS sync_applied_ops_append_only ON sync_applied_ops;--> statement-breakpoint
CREATE TRIGGER sync_applied_ops_append_only
BEFORE UPDATE OR DELETE ON sync_applied_ops
FOR EACH ROW EXECUTE FUNCTION vigilo_sync_applied_ops_append_only();
