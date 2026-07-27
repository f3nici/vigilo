/**
 * @vigilo/shared
 *
 * Types, Zod schemas and pure logic used by both the API and the device.
 * No I/O in this package, ever. If the server and the device can disagree
 * about a rule, that rule belongs here (doc 02 §3).
 */

export * from './access.js';
export * from './auth.js';
export * from './errors.js';
export * from './health.js';
export * from './participants.js';
export * from './password.js';
export * from './roles.js';
export * from './time.js';
