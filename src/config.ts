export interface Config {
  /**
   * Canonical Nextcloud base URL: origin plus any deployment sub-path, with no
   * trailing slash, query, fragment, or credentials. e.g. `https://cloud.example.com`
   * or `https://example.com/nextcloud`.
   */
  url: string;
  /** Nextcloud username. */
  user: string;
  /** Nextcloud app-password (never the user's real account password). */
  password: string;
  /**
   * Task list to use when a tool takes an optional list and the caller omits
   * it. Matched against a list's URI first, then its display name. Unset means
   * the caller must name a list whenever more than one exists.
   */
  defaultTaskList?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
  /** Largest response body to buffer, in bytes. */
  maxResponseBytes: number;
}

const REQUIRED = ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_APP_PASSWORD'] as const;

/** Default per-request deadline; override with NEXTCLOUD_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Largest usable timeout, in milliseconds.
 *
 * `AbortSignal.timeout` documents a ceiling of 4294967295 and throws a
 * `RangeError` on a fraction, but that ceiling is not the usable one: above
 * 2^31-1 Node's timer overflows, emits `TimeoutOverflowWarning` and silently
 * clamps the delay to **1ms**, so every request would abort immediately. A
 * value that turns a long timeout into an instant failure is worse than one
 * that is rejected, so the bound is the 32-bit signed maximum and the check
 * happens at startup, where the message can still name the variable.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default cap on a single response body; override with
 * NEXTCLOUD_MAX_RESPONSE_BYTES.
 *
 * Higher than a JSON API would need: a `calendar-query` REPORT returns every
 * matching task's full iCalendar body in one multistatus document, so the
 * response scales with the size of the list rather than with the page size.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * Reduce a base URL to origin + pathname, rejecting anything that would not
 * survive string concatenation with an endpoint path.
 *
 * Every request is built as `${config.url}${path}`, so a query or fragment in
 * the base would swallow the endpoint path (`…/nextcloud?x=1` + `/remote.php/dav/…`
 * puts the whole DAV path inside the query string). Embedded credentials are
 * rejected separately: they are a secret that would otherwise be echoed by
 * `ping` and other diagnostics.
 */
export function canonicalizeBaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`NEXTCLOUD_URL is not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`NEXTCLOUD_URL must use http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      'NEXTCLOUD_URL must not contain embedded credentials. ' +
        'Pass NEXTCLOUD_USER and NEXTCLOUD_APP_PASSWORD instead.',
    );
  }
  if (url.search) {
    throw new Error(`NEXTCLOUD_URL must not contain a query string, got "${url.search}"`);
  }
  if (url.hash) {
    throw new Error(`NEXTCLOUD_URL must not contain a fragment, got "${url.hash}"`);
  }

  // Keep a deployment sub-path (`/nextcloud`), drop the trailing slash so the
  // appended endpoint path supplies exactly one separator.
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/**
 * Parse a positive-integer environment variable, rejecting the values that
 * would otherwise fail deep inside a request instead of at startup.
 */
function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  if (value > max) {
    throw new Error(`${name} must be at most ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Generate an app-password in Nextcloud (Settings → Security → Devices & sessions) ' +
        'and pass NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD to the MCP server.',
    );
  }

  const defaultTaskList = env.NEXTCLOUD_DEFAULT_TASK_LIST?.trim();

  return {
    url: canonicalizeBaseUrl(env.NEXTCLOUD_URL!.trim()),
    user: env.NEXTCLOUD_USER!.trim(),
    password: env.NEXTCLOUD_APP_PASSWORD!,
    defaultTaskList: defaultTaskList === '' ? undefined : defaultTaskList,
    timeoutMs: parsePositiveInt(
      env.NEXTCLOUD_TIMEOUT_MS,
      'NEXTCLOUD_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxResponseBytes: parsePositiveInt(
      env.NEXTCLOUD_MAX_RESPONSE_BYTES,
      'NEXTCLOUD_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
