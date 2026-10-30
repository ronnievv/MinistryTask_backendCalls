/**
 * Shared outbound HTTP with timeouts, Retry-After handling and jittered backoff.
 * Retries happen ONLY for idempotent requests (GET/HEAD, or callers that opt in
 * explicitly because the provider guarantees idempotency). Non-idempotent writes are
 * never replayed blindly: their uncertain outcomes surface as errors for reconciliation.
 */

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface ProviderRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  /** Opt-in for non-GET methods the provider documents as idempotent. */
  idempotent?: boolean;
}

export interface HttpDeps {
  fetch: FetchFn;
  sleep: SleepFn;
  random: () => number;
  maxRetries: number;
  /** Never wait longer than this for a single Retry-After; fail instead. */
  maxRetryAfterMs: number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  maxRetries: 4,
  maxRetryAfterMs: 60_000,
};

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export class ProviderNetworkError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = "ProviderNetworkError";
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Parses Retry-After as seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)]. */
export function backoffMs(attempt: number, random: () => number, baseMs = 500, capMs = 20_000): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

export async function providerFetch(req: ProviderRequest, deps: HttpDeps = defaultHttpDeps): Promise<Response> {
  const method = (req.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD" || req.idempotent === true;
  const maxAttempts = canRetry ? deps.maxRetries + 1 : 1;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, {
        method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (attempt + 1 < maxAttempts) {
        await deps.sleep(backoffMs(attempt, deps.random));
        continue;
      }
      throw new ProviderNetworkError(
        timedOut ? `Request to ${hostOf(req.url)} timed out` : `Network error calling ${hostOf(req.url)}`,
        timedOut,
      );
    }

    if (res.ok) return res;

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (RETRYABLE_STATUS.has(res.status) && attempt + 1 < maxAttempts) {
      const wait = retryAfterMs ?? backoffMs(attempt, deps.random);
      if (wait <= deps.maxRetryAfterMs) {
        await res.body?.cancel();
        // Small jitter on top of Retry-After so parallel workers don't stampede together.
        await deps.sleep(wait + (retryAfterMs !== undefined ? Math.floor(deps.random() * 250) : 0));
        continue;
      }
    }
    const bodyText = await res.text().catch(() => "");
    throw new ProviderHttpError(`${method} ${hostOf(req.url)} failed with HTTP ${res.status}`, res.status, bodyText, retryAfterMs);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "provider";
  }
}
