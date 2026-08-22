import { Writable } from 'node:stream';
import pino from 'pino';

/**
 * Structured JSON logs with a request id, never containing participant data
 * (doc 02 §7). The redact list grows as tables arrive; nothing clinical is
 * ever logged in the first place, this is the second line of defence.
 *
 * JSON is the contract and stays the default, because it is what an aggregator
 * reads. It is not what a person reads: `docker compose logs -f` was a wall of
 * thousand-character objects, most of it helmet's response headers repeated on
 * every line, and finding a real event in it meant piping the lot through jq.
 * `LOG_FORMAT=pretty` renders the same records one line each instead. Nothing
 * is dropped between the two, so a problem reproduced while watching is the
 * same record support gets.
 */

export const logFormats = ['json', 'pretty'] as const;
export type LogFormat = (typeof logFormats)[number];

export type LoggerOptions = {
  level: string;
  format?: LogFormat;
  /** Overridden by tests. Defaults to stdout. */
  destination?: NodeJS.WritableStream;
};

export function createLogger(options: LoggerOptions | string) {
  const resolved: LoggerOptions = typeof options === 'string' ? { level: options } : options;
  const { level, format = 'json', destination } = resolved;

  const stream =
    format === 'pretty'
      ? prettyStream(destination ?? process.stdout)
      : (destination ?? process.stdout);

  return pino(
    {
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
    },
    stream,
  );
}

export type Logger = ReturnType<typeof createLogger>;

/* ------------------------------------------------------------------ pretty */

/**
 * Colour is on by default in this format, because the only reason to choose it
 * is that a person is reading it. `NO_COLOR` turns it off, which is the
 * convention every other tool on the box follows and is what somebody piping
 * the logs to a file wants. Deciding on `isTTY` would get this backwards: a
 * container's stdout is a pipe, so the one case that needs colour never has it.
 */
function colourEnabled(): boolean {
  return process.env.NO_COLOR === undefined || process.env.NO_COLOR === '';
}

const RESET = '\u001b[0m';

function paint(code: string, text: string): string {
  return colourEnabled() ? `${code}${text}${RESET}` : text;
}

const dim = (text: string) => paint('\u001b[2m', text);
const bold = (text: string) => paint('\u001b[1m', text);

/** pino's numeric levels, in the width the column is padded to. */
const levelStyles: Record<string, { label: string; colour: string }> = {
  fatal: { label: 'FATAL', colour: '\u001b[41;97m' },
  error: { label: 'ERROR', colour: '\u001b[31m' },
  warn: { label: 'WARN ', colour: '\u001b[33m' },
  info: { label: 'INFO ', colour: '\u001b[36m' },
  debug: { label: 'DEBUG', colour: '\u001b[35m' },
  trace: { label: 'TRACE', colour: '\u001b[90m' },
};

/**
 * Keys the line already accounts for, so they are not repeated in the tail of
 * key=value pairs. `pid` and `hostname` go entirely: inside a container they
 * are the same on every line and say nothing.
 */
const accountedFor = new Set([
  'level',
  'time',
  'msg',
  'pid',
  'hostname',
  'req',
  'res',
  'responseTime',
  'err',
]);

function timeOf(record: Record<string, unknown>): string {
  const value = record.time;
  const when = typeof value === 'number' ? new Date(value) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * A value in a key=value tail. Objects are JSON so a line is never ambiguous,
 * and a string with a space in it is quoted for the same reason.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value);
}

function tailOf(record: Record<string, unknown>): string {
  const pairs = Object.entries(record)
    .filter(([key]) => !accountedFor.has(key))
    .map(([key, value]) => `${dim(`${key}=`)}${renderValue(value)}`);
  return pairs.length === 0 ? '' : ` ${pairs.join(' ')}`;
}

/**
 * A finished HTTP request, which is most of the volume and the reason this
 * format exists. Rendered as the line somebody would write by hand:
 * `GET /api/v1/participants 200 12ms`.
 */
function requestLine(record: Record<string, unknown>): string | null {
  const req = record.req as { method?: string; url?: string; id?: unknown } | undefined;
  const res = record.res as { statusCode?: number } | undefined;
  if (req?.method === undefined || req.url === undefined) return null;

  const status = res?.statusCode;
  const took = record.responseTime;

  const parts = [req.method.padEnd(6), req.url];
  if (status !== undefined) parts.push(statusColour(status, String(status)));
  if (typeof took === 'number') parts.push(dim(`${Math.round(took)}ms`));

  return parts.join(' ');
}

function statusColour(status: number, text: string): string {
  if (status >= 500) return paint('\u001b[31m', text);
  if (status >= 400) return paint('\u001b[33m', text);
  if (status >= 300) return paint('\u001b[36m', text);
  return paint('\u001b[32m', text);
}

/** Indented under its line, so a stack never gets mistaken for more events. */
function errorBlock(record: Record<string, unknown>): string {
  const err = record.err as { stack?: string; message?: string; type?: string } | undefined;
  if (err === undefined) return '';

  const body = err.stack ?? `${err.type ?? 'Error'}: ${err.message ?? ''}`;
  return `\n${body
    .split('\n')
    .map((line) => dim(`    ${line.trim()}`))
    .join('\n')}`;
}

export function formatPretty(line: string): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Not ours. Something wrote to the same stream, and swallowing it would be
    // worse than printing it as it came.
    return line;
  }

  const level = typeof record.level === 'string' ? record.level : 'info';
  const style = levelStyles[level] ?? { label: level.toUpperCase().padEnd(5), colour: '' };

  const request = requestLine(record);
  const message = typeof record.msg === 'string' ? record.msg : '';

  // A request log's message is always "request completed", which the line
  // already says better. Anything else keeps its message.
  const body = request ?? bold(message);

  return `${dim(timeOf(record))} ${paint(style.colour, style.label)} ${body}${tailOf(record)}${errorBlock(record)}\n`;
}

/**
 * pino writes whole JSON lines, but a stream is free to hand them over split or
 * batched, so this buffers to a newline rather than assuming one write is one
 * record.
 */
function prettyStream(out: NodeJS.WritableStream): NodeJS.WritableStream {
  let pending = '';

  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      pending += chunk.toString();

      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() !== '') out.write(formatPretty(line));
        newline = pending.indexOf('\n');
      }

      callback();
    },
  });
}
