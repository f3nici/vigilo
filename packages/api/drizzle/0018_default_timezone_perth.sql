-- The organisation timezone default moves to Australia/Perth (D84).
--
-- Melbourne was a placeholder chosen when the schema was first written, and it
-- is not where this team works. It is not a cosmetic setting: every window,
-- every dose and every "daily" calculation is decided in this zone, and it is
-- the only zone staff ever see. A grid built for 06:00 to 22:00 in the wrong
-- zone puts every window two or three hours away from the hours anybody
-- actually works.
ALTER TABLE "org_settings" ALTER COLUMN "timezone" SET DEFAULT 'Australia/Perth';

-- Move an existing row, but only one nobody has ever deliberately set.
--
-- `updated_at = created_at` is the test: the settings row is written once by
-- migration 0001 and touched again only when somebody changes a setting. An
-- org that has chosen its own timezone keeps it, including one that genuinely
-- chose Melbourne.
UPDATE "org_settings"
SET "timezone" = 'Australia/Perth'
WHERE "id" = 1
  AND "timezone" = 'Australia/Melbourne'
  AND "updated_at" = "created_at";
