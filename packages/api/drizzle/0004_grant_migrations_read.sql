-- /api/ready reports whether migrations are current, which means the serving
-- connection has to be able to read the migrator's own bookkeeping table.
-- Without this the check fails closed and a healthy container reports
-- not_ready forever.
--
-- Read only: the app never writes migration history, the owner does.
GRANT USAGE ON SCHEMA drizzle TO vigilo_app;--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO vigilo_app;
