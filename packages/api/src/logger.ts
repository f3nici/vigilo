import pino from 'pino';

/**
 * Structured JSON logs with a request id, never containing participant data
 * (doc 02 §7). The redact list grows as tables arrive; nothing clinical is
 * ever logged in the first place, this is the second line of defence.
 */
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.totp',
        'req.body.recoveryCode',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
