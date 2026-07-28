import { z } from 'zod';

/**
 * Environment is parsed once at startup and fails loudly. A misconfigured
 * container should refuse to start, not serve half a product.
 */

/**
 * A variable that may be absent or blank.
 *
 * `docker compose` passes `${VAR:-}` as an empty string, not as nothing, and a
 * plain `.optional()` accepts only `undefined`. Without this, leaving an
 * optional setting blank the way `.env.example` documents stops the API
 * starting at all, which the container smoke test caught.
 */
function optional(schema: z.ZodString) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    /**
     * What the API uses to serve requests. In a real deployment this is the
     * restricted `vigilo_app` role, which has no UPDATE or DELETE on the audit
     * log (doc 07 §4).
     */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /**
     * Owner connection, used only to run migrations and provision the app
     * role. Falls back to DATABASE_URL for local runs where they are the same.
     */
    MIGRATE_DATABASE_URL: optional(z.string().min(1)),

    /**
     * When both are set, the migration step gives the app role LOGIN and this
     * password. That is what lets the API connect as a role that cannot
     * rewrite the audit log.
     */
    APP_DB_ROLE: z.string().min(1).default('vigilo_app'),
    APP_DB_PASSWORD: optional(z.string().min(1)),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Set by CI to the commit sha. Reported by /api/health as the build hash. */
    BUILD_HASH: z.string().default('dev'),

    /**
     * Wraps the per-table data keys. Never in the repository, never in the
     * image, never in a log. `openssl rand -base64 32` generates one, and
     * `1:<base64>,2:<base64>` carries old versions through a rotation.
     */
    MASTER_KEY: z.string().min(1, 'MASTER_KEY is required'),

    /**
     * Capacitor apps sign in from https://localhost, so the origin has to be
     * allowed and the session cookie has to be SameSite=None. Built in from the
     * first deploy rather than discovered during store review (CareLane cost
     * time on exactly this).
     */
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:8081,https://localhost')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    SESSION_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    /** Off in development so `docker compose up` works without TLS in front. */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /** Installed-app access token lifetime. Refresh tokens rotate (doc 02 §5). */
    ACCESS_TOKEN_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(60),

    /** Lockout after this many consecutive failures (doc 07 §3). */
    MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(10),
    LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

    /**
     * Where attachment bytes live (doc 03 §8). An encrypted volume in a real
     * deployment, and each file is encrypted again under its own data key, so
     * a snapshot of the disk without the master key yields nothing.
     */
    ATTACHMENT_DIR: z.string().min(1).default('/data/attachments'),

    /**
     * VAPID keys for Web Push (doc 04 §14).
     *
     * Optional on purpose. Without them the API still runs and the app still
     * works; it just never asks for notification permission and the push job
     * does nothing. A self-hosted deployment that has not generated keys yet
     * should not be a deployment that will not start.
     *
     * `npm run -w @vigilo/api admin -- push:generate-keys` prints a pair.
     */
    VAPID_PUBLIC_KEY: optional(z.string().min(1)),
    VAPID_PRIVATE_KEY: optional(z.string().min(1)),
    /**
     * The `mailto:` or `https:` the push service contacts about a misbehaving
     * sender. Required by the VAPID spec. Vigilo sends no email itself, and
     * this is not an exception to that: it is a contact address in a header.
     */
    VAPID_SUBJECT: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).default('mailto:admin@example.com'),
    ),

    /** Run pending migrations on boot. Off in tests, which manage their own. */
    MIGRATE_ON_START: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  })
  .transform((env) => ({
    ...env,
    migrateDatabaseUrl: env.MIGRATE_DATABASE_URL ?? env.DATABASE_URL,
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}
