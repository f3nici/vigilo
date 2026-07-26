import { z } from 'zod';

/**
 * Health and readiness contracts (doc 02 §7, doc 04 §15).
 *
 * Neither endpoint requires auth, so neither leaks version detail beyond a
 * build hash.
 */

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  build: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readyCheckSchema = z.object({
  /** Postgres reachable. */
  database: z.boolean(),
  /** No migrations pending. */
  migrations: z.boolean(),
});

export type ReadyCheck = z.infer<typeof readyCheckSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  build: z.string(),
  checks: readyCheckSchema,
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;

export function isReady(checks: ReadyCheck): boolean {
  return checks.database && checks.migrations;
}
