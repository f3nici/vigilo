import {
  apiErrorSchema,
  clockSkewMs,
  healthResponseSchema,
  readyResponseSchema,
  type ErrorCode,
  type HealthResponse,
  type ReadyResponse,
} from '@vigilo/shared';

/** An error the API returned in the documented envelope (doc 04 §1). */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Last measured device clock skew, positive when the device is ahead. */
let lastSkewMs = 0;

export function getClockSkewMs(): number {
  return lastSkewMs;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });

  const serverTime = response.headers.get('X-Server-Time');
  if (serverTime) {
    lastSkewMs = clockSkewMs(new Date(), new Date(serverTime));
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(code, message, details);
    }
    throw new ApiRequestError('server_error', 'Something went wrong. Please try again.');
  }

  return body;
}

export async function getHealth(): Promise<HealthResponse> {
  return healthResponseSchema.parse(await request('/health'));
}

export async function getReady(): Promise<ReadyResponse> {
  return readyResponseSchema.parse(await request('/ready'));
}
