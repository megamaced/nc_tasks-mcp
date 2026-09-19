import { DAV_ROOT, encodeSegment, normalizeEtag, type NextcloudClient } from './http.js';
import { escapeXml, find, findAll, findText, NS, parseXml, type XmlElement } from './xml.js';
import type { TaskList } from './types.js';

/** One `<d:response>` from a multistatus document, reduced to what is used. */
export interface DavResource {
  /** Root-relative, percent-encoded path. */
  href: string;
  /** Properties from `propstat` blocks that reported a 2xx status. */
  props: Map<string, XmlElement>;
  /** Status from a bare `<d:status>` on the response, when there is one. */
  status?: number;
}

/** A calendar object returned by a report, with its etag. */
export interface CalendarObject {
  href: string;
  etag?: string;
  /** The raw iCalendar body, or undefined when the report returned only etags. */
  ics?: string;
}

/** Key a property by namespace and name, matching {@link DavResource.props}. */
export function propKey(ns: string, name: string): string {
  return `${ns}|${name}`;
}

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

/**
 * Parse a multistatus document into its responses.
 *
 * Properties are collected only from `propstat` blocks whose status is 2xx. A
 * `PROPFIND` that asks for a property the resource does not have gets it back
 * inside a 404 block, and treating those as present is how a missing display
 * name turns into an empty string that then overwrites the real one.
 */
export function parseMultistatus(xml: string): DavResource[] {
  const root = parseXml(xml);
  if (root.ns !== NS.dav || root.name !== 'multistatus') {
    throw new Error(`Expected a DAV multistatus response, got <${root.name}>`);
  }

  const resources: DavResource[] = [];
  for (const response of findAll(root, NS.dav, 'response')) {
    const href = findText(response, NS.dav, 'href');
    if (href === undefined || href === '') continue;

    const props = new Map<string, XmlElement>();
    for (const propstat of findAll(response, NS.dav, 'propstat')) {
      const status = parseStatusLine(findText(propstat, NS.dav, 'status'));
      if (status === undefined || status < 200 || status >= 300) continue;
      const prop = find(propstat, NS.dav, 'prop');
      if (!prop) continue;
      for (const child of prop.children) {
        props.set(propKey(child.ns, child.name), child);
      }
    }

    resources.push({
      href: normalizeHref(href),
      props,
      status: parseStatusLine(findText(response, NS.dav, 'status')),
    });
  }
  return resources;
}

/** Status code from a `HTTP/1.1 200 OK` status line. */
function parseStatusLine(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const match = /\s(\d{3})\s/.exec(` ${line} `);
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Reduce an href to a root-relative, percent-encoded path.
 *
 * Servers are free to answer with either an absolute URL or a path, and
 * sabre/dav does both depending on the endpoint. Everything downstream compares
 * and concatenates these, so they are normalised once here.
 */
export function normalizeHref(href: string): string {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Last path segment of a collection href, percent-decoded.
 *
 * This is the stable handle for a task list: Nextcloud derives it from the name
 * the list was created with and never changes it, whereas the display name
 * follows every rename.
 */
export function hrefToUri(href: string): string {
  const segments = href.split('/').filter((s) => s !== '');
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

const PRINCIPAL_BODY = `${XML_HEADER}
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;

const HOME_BODY = `${XML_HEADER}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

/**
 * Find the collection that holds this user's calendars.
 *
 * Follows the RFC 4791 discovery chain — `current-user-principal`, then
 * `calendar-home-set` — rather than assuming the conventional Nextcloud layout,
 * because a deployment behind a path prefix or with a non-default principal
 * path answers correctly to discovery and not to a guess. The conventional path
 * is still the fallback, so a server that declines the `PROPFIND` (some reverse
 * proxies block it at the DAV root) keeps working.
 */
export async function discoverCalendarHome(client: NextcloudClient): Promise<string> {
  const fallback = `${DAV_ROOT}/calendars/${encodeSegment(client.user)}/`;

  try {
    const principalRes = await client.propfind(`${DAV_ROOT}/`, '0', PRINCIPAL_BODY);
    const principalHref = firstHrefProp(
      parseMultistatus(principalRes.body),
      NS.dav,
      'current-user-principal',
    );
    if (!principalHref) return fallback;

    const homeRes = await client.propfind(principalHref, '0', HOME_BODY);
    const homeHref = firstHrefProp(
      parseMultistatus(homeRes.body),
      NS.caldav,
      'calendar-home-set',
    );
    if (!homeHref) return fallback;

    return homeHref.endsWith('/') ? homeHref : `${homeHref}/`;
  } catch {
    // Discovery is an optimisation over the documented layout, not a
    // precondition for it. A server that refuses it still serves calendars.
    return fallback;
  }
}

/** Pull the `<d:href>` nested inside a property such as `calendar-home-set`. */
function firstHrefProp(resources: DavResource[], ns: string, name: string): string | undefined {
  for (const resource of resources) {
    const prop = resource.props.get(propKey(ns, name));
    if (!prop) continue;
    const href = findText(prop, NS.dav, 'href');
    if (href) return normalizeHref(href);
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Task lists
// -----------------------------------------------------------------------------

const CALENDARS_BODY = `${XML_HEADER}
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:cs="http://calendarserver.org/ns/"
            xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
    <ic:calendar-color/>
    <ic:calendar-order/>
  </d:prop>
</d:propfind>`;

const CALENDARSERVER_NS = 'http://calendarserver.org/ns/';

/**
 * List the collections in the calendar home that can hold tasks.
 *
 * Nextcloud stores tasks and events in the same collections, so the filter is
 * on `supported-calendar-component-set` rather than on anything task-specific:
 * a calendar that supports `VTODO` is a task list, whether or not the Tasks UI
 * currently shows it.
 */
export async function listTaskLists(
  client: NextcloudClient,
  calendarHome: string,
): Promise<TaskList[]> {
  const res = await client.propfind(calendarHome, '1', CALENDARS_BODY);
  const lists: TaskList[] = [];

  for (const resource of parseMultistatus(res.body)) {
    // The home collection itself comes back as the first response.
    if (trimSlash(resource.href) === trimSlash(calendarHome)) continue;

    const resourcetype = resource.props.get(propKey(NS.dav, 'resourcetype'));
    if (!resourcetype) continue;
    if (!find(resourcetype, NS.caldav, 'calendar')) continue;
    // A subscription is a read-only mirror of someone else's remote feed;
    // it cannot hold a task this server creates.
    if (find(resourcetype, CALENDARSERVER_NS, 'subscribed')) continue;

    if (!supportsVtodo(resource)) continue;

    const displayName = textOfProp(resource, NS.dav, 'displayname');
    lists.push({
      uri: hrefToUri(resource.href),
      href: resource.href,
      displayName: displayName || hrefToUri(resource.href),
      color: textOfProp(resource, NS.apple, 'calendar-color') || undefined,
      order: numberOfProp(resource, NS.apple, 'calendar-order'),
      readOnly: !isWritable(resource),
      ctag: textOfProp(resource, CALENDARSERVER_NS, 'getctag') || undefined,
    });
  }

  lists.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.displayName.localeCompare(b.displayName));
  return lists;
}

/**
 * Whether the collection accepts `VTODO`.
 *
 * An absent `supported-calendar-component-set` means "everything" per RFC 4791,
 * so it is read as permissive rather than as a rejection.
 */
function supportsVtodo(resource: DavResource): boolean {
  const set = resource.props.get(propKey(NS.caldav, 'supported-calendar-component-set'));
  if (!set) return true;
  const comps = findAll(set, NS.caldav, 'comp');
  if (comps.length === 0) return true;
  return comps.some((c) => (c.attrs.name ?? '').toUpperCase() === 'VTODO');
}

/**
 * Whether the current user may write to the collection.
 *
 * An absent privilege set is treated as writable: the property is optional, and
 * assuming read-only would hide every list on a server that does not report it.
 */
function isWritable(resource: DavResource): boolean {
  const set = resource.props.get(propKey(NS.dav, 'current-user-privilege-set'));
  if (!set) return true;
  for (const privilege of findAll(set, NS.dav, 'privilege')) {
    for (const granted of privilege.children) {
      if (granted.ns !== NS.dav) continue;
      if (granted.name === 'write' || granted.name === 'write-content' || granted.name === 'all') {
        return true;
      }
    }
  }
  return false;
}

function textOfProp(resource: DavResource, ns: string, name: string): string {
  return resource.props.get(propKey(ns, name))?.text.trim() ?? '';
}

function numberOfProp(resource: DavResource, ns: string, name: string): number | undefined {
  const text = textOfProp(resource, ns, name);
  if (text === '' || !/^-?\d+$/.test(text)) return undefined;
  return Number(text);
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

// -----------------------------------------------------------------------------
// Reports
// -----------------------------------------------------------------------------

/**
 * Build a `calendar-query` for the `VTODO`s in a collection.
 *
 * Only completion is filtered server-side, and only as a payload reduction: a
 * task may carry `STATUS:COMPLETED` with no `COMPLETED` timestamp, so the
 * authoritative filtering happens once the components are parsed. Due-date
 * windows are filtered client-side for the same reason — RFC 4791's
 * `time-range` for `VTODO` resolves against `DTSTART`, `DUE`, `DURATION`,
 * `COMPLETED` *and* `CREATED` in combination, which is not the "tasks due in
 * this window" that a caller asking for a due-date window means.
 */
export function buildCalendarQuery(opts: { excludeCompleted?: boolean; uid?: string } = {}): string {
  const completedFilter = opts.excludeCompleted
    ? `
        <c:prop-filter name="COMPLETED">
          <c:is-not-defined/>
        </c:prop-filter>`
    : '';

  // `i;octet` is an exact byte comparison. A UID is an opaque identifier, so
  // the default case-insensitive collation could match a different task.
  const uidFilter = opts.uid
    ? `
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${escapeXml(opts.uid)}</c:text-match>
        </c:prop-filter>`
    : '';

  return `${XML_HEADER}
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">${completedFilter}${uidFilter}
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/** Build a `calendar-multiget` for specific hrefs. */
export function buildMultiget(hrefs: readonly string[]): string {
  const items = hrefs.map((h) => `  <d:href>${escapeXml(h)}</d:href>`).join('\n');
  return `${XML_HEADER}
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
${items}
</c:calendar-multiget>`;
}

/** Extract the calendar objects from a report's multistatus response. */
export function parseCalendarObjects(xml: string): CalendarObject[] {
  const objects: CalendarObject[] = [];
  for (const resource of parseMultistatus(xml)) {
    // A multiget for an href that has since been deleted answers 404 here.
    if (resource.status !== undefined && (resource.status < 200 || resource.status >= 300)) {
      continue;
    }
    const etag = normalizeEtag(resource.props.get(propKey(NS.dav, 'getetag'))?.text.trim() ?? null);
    const data = resource.props.get(propKey(NS.caldav, 'calendar-data'));
    objects.push({
      href: resource.href,
      ...(etag ? { etag } : {}),
      ...(data ? { ics: data.text } : {}),
    });
  }
  return objects;
}

/** Run a `calendar-query` against one collection. */
export async function queryTasks(
  client: NextcloudClient,
  listHref: string,
  opts: { excludeCompleted?: boolean; uid?: string } = {},
): Promise<CalendarObject[]> {
  const res = await client.report(listHref, buildCalendarQuery(opts));
  return parseCalendarObjects(res.body);
}

/** Fetch specific calendar objects from one collection. */
export async function multigetTasks(
  client: NextcloudClient,
  listHref: string,
  hrefs: readonly string[],
): Promise<CalendarObject[]> {
  if (hrefs.length === 0) return [];
  const res = await client.report(listHref, buildMultiget(hrefs));
  return parseCalendarObjects(res.body);
}
