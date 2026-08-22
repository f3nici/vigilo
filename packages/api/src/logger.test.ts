import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatPretty } from './logger.js';
import { httpLogging } from './app.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Colour would make every assertion here a comparison of escape codes. */
function plain(line: string): string {
  vi.stubEnv('NO_COLOR', '1');
  return formatPretty(line);
}

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 'info', time: Date.UTC(2026, 0, 1, 0, 0, 0), ...fields });
}

describe('the pretty format', () => {
  it('puts a finished request on one line, as method path status duration', () => {
    const line = plain(
      record({
        req: { id: 'abc', method: 'GET', url: '/api/v1/participants' },
        res: { statusCode: 200 },
        responseTime: 12,
        msg: 'request completed',
      }),
    );

    expect(line).toContain('GET');
    expect(line).toContain('/api/v1/participants');
    expect(line).toContain('200');
    expect(line).toContain('12ms');
    // The message says nothing the line has not already said better.
    expect(line).not.toContain('request completed');
  });

  it('keeps the message for anything that is not a request', () => {
    const line = plain(record({ msg: 'vigilo api listening', port: 3000, build: 'local' }));

    expect(line).toContain('vigilo api listening');
    expect(line).toContain('port=3000');
    expect(line).toContain('build=local');
  });

  it('drops pid and hostname, which are one value per container', () => {
    const line = plain(record({ msg: 'up', pid: 8, hostname: 'ce1e440e66d6' }));

    expect(line).not.toContain('pid=');
    expect(line).not.toContain('hostname=');
    expect(line).not.toContain('ce1e440e66d6');
  });

  it('names the level, so the levels are worth setting', () => {
    expect(plain(JSON.stringify({ level: 'warn', msg: 'careful' }))).toContain('WARN');
    expect(plain(JSON.stringify({ level: 'error', msg: 'broke' }))).toContain('ERROR');
    expect(plain(JSON.stringify({ level: 'debug', msg: 'detail' }))).toContain('DEBUG');
  });

  it('indents a stack under its line rather than letting it read as more events', () => {
    const line = plain(
      record({ level: 'error', msg: 'job failed', err: { stack: 'Error: nope\n    at thing' } }),
    );

    expect(line).toContain('job failed');
    expect(line.split('\n')[1]).toMatch(/^\s+Error: nope/);
  });

  it('quotes a value with a space in it, so a line is never ambiguous', () => {
    expect(plain(record({ msg: 'x', reason: 'two words' }))).toContain('reason="two words"');
  });

  it('passes a line through when it is not ours', () => {
    // Something else wrote to the same stream. Swallowing it would be worse.
    expect(plain('a plain line from somewhere else')).toBe('a plain line from somewhere else');
  });

  it('colours by default and stops when NO_COLOR is set', () => {
    vi.stubEnv('NO_COLOR', '');
    expect(formatPretty(record({ msg: 'hello' }))).toContain('[');

    vi.stubEnv('NO_COLOR', '1');
    expect(formatPretty(record({ msg: 'hello' }))).not.toContain('[');
  });
});

describe('createLogger', () => {
  /** Collects what the logger wrote, whichever format it was in. */
  async function written(
    format: 'json' | 'pretty',
    write: (log: ReturnType<typeof createLogger>) => void,
  ) {
    const destination = new PassThrough();
    let output = '';
    destination.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    write(createLogger({ level: 'info', format, destination }));
    await new Promise((resolve) => setImmediate(resolve));
    return output;
  }

  it('still writes JSON by default, which is what doc 02 §7 promises', async () => {
    const output = await written('json', (log) => {
      log.info({ port: 3000 }, 'listening');
    });

    expect(JSON.parse(output.trim())).toMatchObject({
      level: 'info',
      port: 3000,
      msg: 'listening',
    });
  });

  it('writes a readable line in pretty, from the same call', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const output = await written('pretty', (log) => {
      log.info({ port: 3000 }, 'listening');
    });

    expect(output).toContain('listening');
    expect(output).toContain('port=3000');
    expect(output).not.toContain('"level"');
  });

  it('takes a bare level, so the old single-argument callers still work', () => {
    expect(createLogger('warn').level).toBe('warn');
  });
});

describe('what a request log is allowed to say', () => {
  const options = httpLogging(createLogger('silent'));

  /**
   * `url` is what Express leaves on the request once a router has it, which is
   * relative to the mount. `originalUrl` is the whole path and is what a
   * matcher has to read.
   */
  function levelFor(
    request: { originalUrl?: string | undefined; url?: string | undefined },
    statusCode: number,
    err?: Error,
  ): string {
    const custom = options.customLogLevel;
    if (custom === undefined) throw new Error('no customLogLevel');
    return custom.call(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...request, method: 'GET' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { statusCode } as any,
      err,
    );
  }

  /** A request as it reaches the level check, after the /api router has it. */
  function mounted(path: string): { originalUrl: string; url: string } {
    return { originalUrl: path, url: path.replace(/^\/api/, '') };
  }

  it('logs a 5xx as an error and a 4xx as a warning', () => {
    expect(levelFor(mounted('/api/v1/checks'), 500)).toBe('error');
    expect(levelFor(mounted('/api/v1/checks'), 401)).toBe('warn');
  });

  it('logs a thrown error as an error whatever the status says', () => {
    expect(levelFor(mounted('/api/v1/checks'), 200, new Error('boom'))).toBe('error');
  });

  it('drops a healthy probe to debug, so info is not one every ten seconds', () => {
    expect(levelFor(mounted('/api/health'), 200)).toBe('debug');
    expect(levelFor(mounted('/api/ready'), 200)).toBe('debug');
    expect(levelFor(mounted('/api/ready?verbose=1'), 200)).toBe('debug');
  });

  it('matches the probe on the path Express has not rewritten', () => {
    // The bug this replaced: req.url is '/health' by the time the level is
    // chosen, so matching on it never fired and every probe logged at info.
    expect(levelFor({ originalUrl: '/api/health', url: '/health' }, 200)).toBe('debug');
    // And still works for anything that only has the one.
    expect(levelFor({ url: '/api/health' }, 200)).toBe('debug');
  });

  it('keeps a failing probe at the level its status earns', () => {
    // A probe nobody sees failing is the one case the quiet rule must not cover.
    expect(levelFor(mounted('/api/ready'), 503)).toBe('error');
    expect(levelFor(mounted('/api/health'), 500)).toBe('error');
  });

  it('logs an ordinary request at info', () => {
    expect(levelFor(mounted('/api/v1/participants'), 200)).toBe('info');
  });

  it('serialises a request down to what is safe and worth reading', () => {
    const serializers = options.serializers;
    if (serializers?.req === undefined || serializers.res === undefined) {
      throw new Error('no serializers');
    }

    const serialised = serializers.req({
      id: 'abc',
      method: 'POST',
      url: '/api/v1/auth/login',
      // The default serialiser put all of this on every line.
      headers: { cookie: 'session=secret', authorization: 'Bearer token' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as Record<string, unknown>;

    expect(serialised).toEqual({ id: 'abc', method: 'POST', url: '/api/v1/auth/login' });
    expect(serialised.headers).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(serializers.res({ statusCode: 204, headers: { 'set-cookie': 'x' } } as any)).toEqual({
      statusCode: 204,
    });
  });
});
