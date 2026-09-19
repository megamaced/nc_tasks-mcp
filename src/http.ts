import type { Config } from './config.js';

/** Root of Nextcloud's DAV tree. Everything CalDAV hangs off this. */
export const DAV_ROOT = '/remote.php/dav';

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

const DEBUG = !!process.env.DEBUG;

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[tasks-mcp] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Retry configuration
// -----------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
/** Upper bound on any single retry delay, including server-provided Retry-After. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Methods that may be replayed without changing the result beyond that of a
 * single call.
 *
 * `REPORT` is here because CalDAV uses it as a read: `calendar-query` and
 * `calendar-multiget` are searches spelled as a method with a body, and the
 * body is the only reason they are not GETs.
 *
 * `PUT` and `DELETE` are deliberately absent, even though HTTP calls them
 * idempotent. That guarantee is about server *state*, not about the response,
 * and the response is what this server reports back: a conditional PUT that
 * commits and then loses its reply returns 412 on replay, and a committed
 * DELETE returns 404. Either would report failure for a write that succeeded.
 */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']);

/**
 * A 5xx is ambiguous — a write may have been committed before the error, and
 * its response lost. Only replay it when the response itself is reproducible.
 * A 429 is always safe to replay: the server rejected the request outright.
 */
function isRetryable(status: number, replayable: boolean): boolean {
  if (status === 429) return true;
  return replayable && status >= 500 && status <= 599;
}

/**
 * Transient transport failures (connection reset, DNS blip, socket close).
 * Deliberately excludes AbortError: a request that hit its deadline is
 * reported to the caller rather than replayed.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (code) {
    return [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code);
  }
  // Undici surfaces network failures as a bare TypeError('fetch failed').
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for the given zero-based attempt, capped. */
function backoffDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
}

/**
 * Largest number of redirects followed within the configured origin.
 *
 * Nextcloud behind a reverse proxy legitimately redirects — a missing trailing
 * slash on a collection, most commonly — but never more than once or twice.
 */
const MAX_REDIRECTS = 5;

/** A redirect this server declined to follow. */
export class RedirectRefusedError extends Error {
  public readonly hint =
    'Point NEXTCLOUD_URL directly at the Nextcloud origin. A DAV endpoint that ' +
    'redirects elsewhere is not one this server will follow.';

  constructor(from: string, to: string) {
    super(
      `Refused to follow a redirect from ${from} to ${to}: it leaves the configured ` +
        'Nextcloud origin. [Point NEXTCLOUD_URL directly at the Nextcloud origin. A DAV ' +
        'endpoint that redirects elsewhere is not one this server will follow.]',
    );
    this.name = 'RedirectRefusedError';
  }
}

/** A request that exceeded its deadline. Never retried. */
export class TimeoutError extends Error {
  public readonly hint =
    'The Nextcloud server may be unreachable or overloaded. ' +
    'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.';

  constructor(label: string, timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms: ${label} ` +
        '[The Nextcloud server may be unreachable or overloaded. ' +
        'Raise NEXTCLOUD_TIMEOUT_MS if the operation is legitimately slow.]',
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Parse a Retry-After header. Returns delay in milliseconds clamped to
 * {@link MAX_RETRY_DELAY_MS}, or null if the header is absent / unparseable.
 * The cap stops a hostile or misconfigured server from stalling the MCP
 * client indefinitely.
 */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const clamp = (ms: number) => Math.min(Math.max(0, ms), MAX_RETRY_DELAY_MS);
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  if (!isNaN(date)) return clamp(date - Date.now());
  return null;
}

// -----------------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------------

const ERROR_BODY_MAX = 300;

/** A response body that exceeded the configured size limit. */
export class ResponseTooLargeError extends Error {
  public readonly hint =
    'Narrow the query (a single task list, a due-date window, or ' +
    'includeCompleted: false) or raise NEXTCLOUD_MAX_RESPONSE_BYTES.';

  constructor(label: string, limit: number, seen: number | null) {
    super(
      `Response too large: ${label} exceeded the ${limit}-byte limit` +
        `${seen === null ? '' : ` (server declared ${seen} bytes)`} ` +
        '[Narrow the query (a single task list, a due-date window, or ' +
        'includeCompleted: false) or raise NEXTCLOUD_MAX_RESPONSE_BYTES.]',
    );
    this.name = 'ResponseTooLargeError';
  }
}

/** A failed HTTP response (non-2xx status). */
export class HttpError extends Error {
  /** Human-readable suggestion for how the caller might fix the problem. */
  public readonly hint: string;

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    body: string,
  ) {
    const detail = sabreMessage(body) ?? body;
    const snippet = detail.length > ERROR_BODY_MAX ? `${detail.slice(0, ERROR_BODY_MAX)}…` : detail;
    const hint = httpHint(status);
    super(`HTTP ${status} ${statusText}${snippet ? `: ${snippet}` : ''}${hint ? ` [${hint}]` : ''}`);
    this.name = 'HttpError';
    this.hint = hint;
  }
}

/**
 * Pull the human-readable part out of a sabre/dav error document.
 *
 * sabre/dav answers a failed DAV request with an XML fault whose useful content
 * is one `<s:message>` element buried in namespace declarations and a PHP stack
 * trace. Reporting the raw document instead spends the caller's context on
 * noise, so the message is lifted out when it is there.
 */
function sabreMessage(body: string): string | null {
  const match = /<[^:>]*:?message[^>]*>([\s\S]*?)<\/[^:>]*:?message>/i.exec(body);
  if (!match?.[1]) return null;
  const text = match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
  return text === '' ? null : text;
}

function httpHint(status: number): string {
  switch (status) {
    case 400:
      return 'The server rejected the request body — this is a bug in tasks-mcp, not in the arguments.';
    case 401:
      return 'Check NEXTCLOUD_APP_PASSWORD — it may be expired or revoked.';
    case 403:
      return 'The task list is read-only, or the app-password lacks permission.';
    case 404:
      return 'Not found — the task or task list may have been deleted, or the Tasks app is not enabled for this user.';
    case 405:
      return 'Method not allowed — the path is not a CalDAV collection.';
    case 409:
      return 'Conflict — the parent collection does not exist.';
    case 412:
      return 'The task changed on the server since the etag you passed. Re-read it and retry.';
    case 415:
      return 'The server rejected the iCalendar content type.';
    case 423:
      return 'Locked — the resource is locked by another process or user.';
    case 429:
      return 'Rate-limited — too many requests. Retry later.';
    case 507:
      return 'Insufficient storage on the Nextcloud server.';
    default:
      if (status >= 500) return 'Server error — Nextcloud may be overloaded or misconfigured.';
      return '';
  }
}

/**
 * A conditional write refused because the task changed on the server first.
 *
 * Unlike the Notes API, CalDAV returns no body with a 412 — there is nothing to
 * merge against without a second round-trip, so the error says how to get one
 * rather than pretending to carry it.
 */
export class ConflictError extends Error {
  public readonly hint =
    'Re-read the task with get_task to pick up the current etag and content, ' +
    'merge your change into it, and retry — or omit the etag to overwrite ' +
    'whatever is there.';

  constructor(public readonly href: string) {
    super(
      `HTTP 412 Precondition Failed: ${href} was modified on the server since the ` +
        'etag you supplied. [Re-read the task with get_task to pick up the current ' +
        'etag and content, merge your change into it, and retry — or omit the etag ' +
        'to overwrite whatever is there.]',
    );
    this.name = 'ConflictError';
  }
}

/** A `PUT` that was meant to create a resource but found one already there. */
export class AlreadyExistsError extends Error {
  public readonly hint = 'Retry — a fresh UID will be generated.';

  constructor(href: string) {
    super(`A task already exists at ${href}. [Retry — a fresh UID will be generated.]`);
    this.name = 'AlreadyExistsError';
  }
}

/** A DAV response, with the headers CalDAV uses as protocol. */
export interface DavResponse {
  status: number;
  /** Decoded response body. Empty for a 204. */
  body: string;
  /** Entity tag of the affected resource, when the server returned one. */
  etag: string | null;
  /** Absolute or root-relative path the server reports for a created resource. */
  location: string | null;
}

export class NextcloudClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: Config) {
    this.maxResponseBytes = config.maxResponseBytes;
    const token = Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${token}`;
    this.timeoutMs = config.timeoutMs;
    if (config.url.startsWith('http://')) {
      process.stderr.write(
        '[tasks-mcp] WARNING: NEXTCLOUD_URL uses http:// — ' +
          'credentials will be sent in plain text. Use https:// in production.\n',
      );
    }
  }

  /** The configured Nextcloud base URL, without credentials. */
  get baseUrl(): string {
    return this.config.url;
  }

  /** The configured Nextcloud username. */
  get user(): string {
    return this.config.user;
  }

  /** Absolute URL for a DAV path. `path` must already be percent-encoded. */
  absoluteUrl(path: string): string {
    return `${this.config.url}${path}`;
  }

  // ---------------------------------------------------------------------------
  // Shared retry logic
  // ---------------------------------------------------------------------------

  /**
   * Fetch with a per-request deadline and bounded retries.
   *
   * Retries exactly one delay per attempt: the server's `Retry-After` when it
   * supplies one, otherwise exponential backoff — both capped at
   * {@link MAX_RETRY_DELAY_MS}. 429 is retried for every method; 5xx and
   * transient network failures only for replayable requests, so an ambiguous
   * write is never silently duplicated.
   *
   * 207, 304, 412 and 404 are returned rather than thrown: each is a protocol
   * signal CalDAV uses deliberately, and the caller decides what it means.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
    passThrough: ReadonlySet<number>,
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const replayable = REPLAYABLE_METHODS.has(method);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      debug(attempt === 0 ? label : `Retry ${attempt}/${MAX_RETRIES} for ${label}`);

      let res: Response;
      try {
        res = await this.fetchFollowingSameOrigin(url, init, label);
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new TimeoutError(label, this.timeoutMs);
        }
        if (err instanceof RedirectRefusedError) throw err;
        if (isTransientNetworkError(err) && replayable && attempt < MAX_RETRIES) {
          lastError = err as Error;
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw err;
      }

      if (res.ok || passThrough.has(res.status)) return res;

      // Bounded: an error body can be an arbitrarily large proxy error page.
      const text = await this.readBounded(res, label).catch(() => '');
      const httpError = new HttpError(res.status, res.statusText, text);

      if (isRetryable(res.status, replayable) && attempt < MAX_RETRIES) {
        lastError = httpError;
        await sleep(parseRetryAfter(res) ?? backoffDelay(attempt));
        continue;
      }
      throw httpError;
    }
    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  /**
   * Fetch, following redirects only while they stay on the configured origin.
   *
   * Node's fetch follows redirects itself, and follows them anywhere. That
   * turns the configured Nextcloud endpoint into a lever: a malicious or
   * compromised server can answer a DAV request with a 302 to any address the
   * host can reach — `localhost`, a cloud metadata service, something else on
   * the LAN — and this process will fetch it and hand the body back through
   * tool output. Node does strip `Authorization` when the origin changes, which
   * protects the credential but neither prevents the request nor stops the
   * response being disclosed; on a body-carrying method it would also forward
   * the task content to whatever answered.
   *
   * So redirects are resolved here instead, against an explicit policy: same
   * origin only, bounded in number. The one concession is an http→https upgrade
   * on the same host and port, which is a strict improvement rather than a
   * redirection.
   */
  private async fetchFollowingSameOrigin(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // 304 shares the 3xx range but is a cache validator, not a redirect.
      if (res.status < 300 || res.status > 399 || res.status === 304) return res;

      const location = res.headers.get('Location');
      if (!location) return res; // A 3xx with nowhere to go; let the caller judge.

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new RedirectRefusedError(current, location);
      }
      if (!this.isSameOrigin(next, current)) {
        throw new RedirectRefusedError(current, next.toString());
      }
      // Discard the unread body before reusing the connection.
      await res.body?.cancel().catch(() => {});
      current = next.toString();
      debug(`Redirect ${hop + 1}/${MAX_REDIRECTS} for ${label} -> ${current}`);
    }

    throw new RedirectRefusedError(url, `more than ${MAX_REDIRECTS} redirects`);
  }

  /** Whether `next` stays on the origin of `from`, allowing an https upgrade. */
  private isSameOrigin(next: URL, from: string): boolean {
    let base: URL;
    try {
      base = new URL(from);
    } catch {
      return false;
    }
    if (next.origin === base.origin) return true;
    return (
      base.protocol === 'http:' &&
      next.protocol === 'https:' &&
      next.hostname === base.hostname &&
      next.port === base.port
    );
  }

  /**
   * Read a response body, refusing to buffer more than the configured limit.
   *
   * `Response.text()` buffers whatever the peer sends, so the cap has to be
   * applied while reading rather than afterwards. `Content-Length` is checked
   * first when present so an oversized body is rejected before a single chunk
   * is read — which matters more here than for a JSON API, because a
   * `calendar-query` over a large list legitimately returns megabytes.
   */
  private async readBounded(res: Response, label: string): Promise<string> {
    const declared = res.headers.get('Content-Length');
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > this.maxResponseBytes) {
        throw new ResponseTooLargeError(label, this.maxResponseBytes, size);
      }
    }
    if (!res.body) return '';

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(label, this.maxResponseBytes, null);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  // ---------------------------------------------------------------------------
  // DAV
  // ---------------------------------------------------------------------------

  /**
   * Issue a DAV request. `path` is a percent-encoded, root-relative path.
   *
   * @param passThrough Statuses returned to the caller instead of raising.
   */
  async dav(
    method: string,
    path: string,
    opts: {
      body?: string;
      headers?: Record<string, string>;
      passThrough?: readonly number[];
    } = {},
  ): Promise<DavResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      ...opts.headers,
    };
    if (opts.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/xml; charset=utf-8';
    }

    const label = `${method} ${path}`;
    // 207 is how every PROPFIND and REPORT succeeds, so it is always allowed.
    const passThrough = new Set<number>([207, ...(opts.passThrough ?? [])]);

    const res = await this.fetchWithRetry(
      this.absoluteUrl(path),
      { method, headers, body: opts.body },
      label,
      passThrough,
    );

    const body = res.status === 204 ? '' : await this.readBounded(res, label);
    return {
      status: res.status,
      body,
      etag: normalizeEtag(res.headers.get('ETag')),
      location: res.headers.get('Location'),
    };
  }

  /** `PROPFIND` with the given depth and request body. */
  async propfind(path: string, depth: '0' | '1', body: string): Promise<DavResponse> {
    return this.dav('PROPFIND', path, { body, headers: { Depth: depth } });
  }

  /** `REPORT` at depth 1, which is what both CalDAV read reports use. */
  async report(path: string, body: string): Promise<DavResponse> {
    return this.dav('REPORT', path, { body, headers: { Depth: '1' } });
  }

  /**
   * Write a calendar object.
   *
   * @param etag Sent as `If-Match`, making the write conditional on the task
   *   not having changed. Raises {@link ConflictError} if it has.
   * @param mustNotExist Sends `If-None-Match: *`, refusing to overwrite an
   *   existing resource. Used when creating, where a collision means the
   *   generated UID was already taken.
   */
  async putCalendarObject(
    path: string,
    ics: string,
    opts: { etag?: string; mustNotExist?: boolean } = {},
  ): Promise<DavResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8',
    };
    if (opts.etag) headers['If-Match'] = opts.etag;
    if (opts.mustNotExist) headers['If-None-Match'] = '*';

    const res = await this.dav('PUT', path, { body: ics, headers, passThrough: [412] });
    if (res.status === 412) {
      throw opts.mustNotExist ? new AlreadyExistsError(path) : new ConflictError(path);
    }
    return res;
  }

  /** Delete a calendar object, optionally conditional on its etag. */
  async deleteCalendarObject(path: string, etag?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (etag) headers['If-Match'] = etag;
    const res = await this.dav('DELETE', path, { headers, passThrough: [412] });
    if (res.status === 412) throw new ConflictError(path);
  }
}

/**
 * Reduce an ETag to the form that can be compared and sent back.
 *
 * A weak validator arrives as `W/"abc"`. The `W/` prefix is dropped because
 * `If-Match` requires a strong comparison, and a value sent back with the
 * prefix intact is not the same validator the server issued.
 */
export function normalizeEtag(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const value = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  return value === '' ? null : value;
}

/**
 * Percent-encode one path segment for use in a DAV URL.
 *
 * `encodeURIComponent` leaves `!'()*` alone; they are legal in a path, so this
 * is only about producing the same spelling the server does when it echoes an
 * `href` back, which is what makes hrefs comparable.
 */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
