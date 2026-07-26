-- The single settings row. Every window and "daily" calculation reads its
-- timezone, so the row has to exist before anything else does. Idempotent, so
-- rerunning migrations never overwrites a configured org.
INSERT INTO "org_settings" ("id", "org_name")
VALUES (1, 'Vigilo')
ON CONFLICT ("id") DO NOTHING;
