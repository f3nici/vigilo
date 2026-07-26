import { z } from 'zod';

/**
 * Environment is parsed once at startup and fails loudly. A misconfigured
 * container should refuse to start, not serve half a product.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Set by CI to the commit sha. Reported by /api/health as the build hash. */
  BUILD_HASH: z.string().default('dev'),

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

  /** Run pending migrations on boot. Off in tests, which manage their own. */
  MIGRATE_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

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
