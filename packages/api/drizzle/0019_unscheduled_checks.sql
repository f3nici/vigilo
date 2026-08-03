-- Checks recorded on demand, with no window behind them (D89).
--
-- A worker needs to be able to open a participant, pick a form and record it
-- there and then: a blood pressure somebody asked about, an observation nobody
-- put on a schedule. Until now every entry hung off a materialised window, so
-- the only way to record anything was for an admin to have scheduled it first.
--
-- This is the same shape PRN medication already uses, where
-- `medication_administrations.dose_id` is nullable and a PRN dose has none.

ALTER TABLE "check_entries" ALTER COLUMN "window_id" DROP NOT NULL;

-- One entry per window still holds, but only for the entries that have one.
-- A plain unique index would treat every unscheduled entry as colliding with
-- every other, because in SQL NULL is not equal to NULL but the constraint
-- would still be the wrong statement to make.
ALTER TABLE "check_entries" DROP CONSTRAINT IF EXISTS "check_entries_window_key";

CREATE UNIQUE INDEX IF NOT EXISTS "check_entries_window_key"
  ON "check_entries" ("window_id")
  WHERE "window_id" IS NOT NULL;

-- An unscheduled entry is found by participant and time, which is how the
-- timeline, the daily report and a participant's own record all read it.
CREATE INDEX IF NOT EXISTS "check_entries_unscheduled_idx"
  ON "check_entries" ("participant_id", "recorded_at")
  WHERE "window_id" IS NULL;
