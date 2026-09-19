import ICAL from 'ical.js';

import { TASK_STATUSES, type Task, type TaskDate, type TaskStatus } from './types.js';

/** `PRODID` written on calendars this server creates. */
const PRODID = '-//megamaced//tasks-mcp//EN';

/** A malformed or unusable iCalendar body. */
export class IcalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcalError';
  }
}

// -----------------------------------------------------------------------------
// Date handling
// -----------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(Z)?$/;

/**
 * Read a date property as a {@link TaskDate}.
 *
 * The `TZID` is taken from the *parameter*, not from `value.zone`. ical.js only
 * resolves a zone it has been given a `VTIMEZONE` for, and Nextcloud does not
 * always include one; without it every zoned time parses as "floating" and the
 * zone silently disappears from anything read back. The parameter is on the
 * wire either way.
 */
function readDate(comp: ICAL.Component, name: string): TaskDate | undefined {
  const prop = comp.getFirstProperty(name);
  if (!prop) return undefined;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) return undefined;

  if (value.isDate) {
    return { value: value.toString(), isDate: true };
  }

  const tzid = prop.getParameter('tzid');
  const zone = typeof tzid === 'string' ? tzid : undefined;
  const isUtc = value.zone === ICAL.Timezone.utcTimezone;
  // `toString()` renders an ISO-ish local time; UTC gets the Z it needs.
  const local = value.toString().replace(/Z$/, '');
  return {
    value: isUtc ? `${local}Z` : local,
    isDate: false,
    ...(zone ? { timezone: zone } : {}),
  };
}

/** UTC offset in milliseconds that `timezone` had at the given instant. */
function offsetAt(utcMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/**
 * Resolve a wall-clock reading in a named zone to the UTC instant it denotes.
 *
 * Two passes, because the offset depends on the very instant being computed:
 * the first pass assumes the reading is UTC to get an offset in the right
 * neighbourhood, the second re-checks it once the estimate has crossed to the
 * correct side of a DST boundary.
 */
function zonedToUtc(fields: number[], timezone: string): Date {
  const [y, mo, d, h, mi, s] = fields as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = offsetAt(naive, timezone);
  let ms = naive - first;
  const second = offsetAt(ms, timezone);
  if (second !== first) ms = naive - second;
  return new Date(ms);
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new IcalError(
      `Unknown timezone "${timezone}". Use an IANA zone name such as "Europe/London".`,
    );
  }
}

/**
 * Convert a caller-supplied date string into an `ICAL.Time`.
 *
 * A zoned time is stored as the equivalent UTC instant rather than as a local
 * time with a `TZID`. A `TZID` is only valid alongside a matching `VTIMEZONE`
 * in the same calendar object, and ical.js cannot generate one for an arbitrary
 * zone without a bundled tz database — so writing the parameter alone would
 * emit non-conformant iCalendar that other CalDAV clients are free to read
 * differently. The UTC instant is exact, unambiguous, and displayed in the
 * reader's own zone by every client including the Tasks UI.
 */
export function parseDateInput(value: string, timezone?: string): ICAL.Time {
  const text = value.trim();

  if (DATE_ONLY.test(text)) {
    if (timezone) {
      throw new IcalError(
        `"${text}" is a whole day, which has no timezone. Drop the timezone, or ` +
          'give a time as well (e.g. "2026-03-01T09:00:00").',
      );
    }
    return ICAL.Time.fromDateString(text);
  }

  const match = DATE_TIME.exec(text);
  if (!match) {
    throw new IcalError(
      `Invalid date "${value}". Use "YYYY-MM-DD" for a whole day, ` +
        '"YYYY-MM-DDTHH:MM:SS" for a local time, or "YYYY-MM-DDTHH:MM:SSZ" for UTC.',
    );
  }

  const [, datePart, timePart, zulu] = match as unknown as [string, string, string, string?];
  const time = timePart.length === 5 ? `${timePart}:00` : timePart;

  if (zulu) {
    if (timezone) {
      throw new IcalError(
        `"${text}" already ends in Z, which means UTC. Drop the timezone, or drop the Z.`,
      );
    }
    return ICAL.Time.fromDateTimeString(`${datePart}T${time}Z`);
  }

  if (timezone) {
    assertValidTimezone(timezone);
    const fields = [...datePart.split('-'), ...time.split(':')].map(Number);
    return ICAL.Time.fromJSDate(zonedToUtc(fields, timezone), true);
  }

  // No zone and no Z: a floating time, which means the same wall-clock reading
  // wherever it is read. Preserved rather than guessed at.
  return ICAL.Time.fromDateTimeString(`${datePart}T${time}`);
}

/** Now, as a UTC `ICAL.Time`, with sub-second precision dropped. */
function nowUtc(): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(), true);
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

function readString(comp: ICAL.Component, name: string): string | undefined {
  const value = comp.getFirstPropertyValue(name);
  if (typeof value !== 'string') return undefined;
  return value === '' ? undefined : value;
}

function readInt(comp: ICAL.Component, name: string): number | undefined {
  const value = comp.getFirstPropertyValue(name);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * Read an X-property written as a boolean.
 *
 * Clients disagree on the spelling — Nextcloud writes `1`/`0` for
 * `X-OC-HIDESUBTASKS` but `true`/`false` for `X-PINNED` — so both are accepted
 * and anything else is treated as absent rather than as false.
 */
function readBooleanish(comp: ICAL.Component, name: string): boolean | undefined {
  const value = comp.getFirstPropertyValue(name);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === '1' || text === 'true') return true;
  if (text === '0' || text === 'false') return false;
  return undefined;
}

/**
 * Every value across every `CATEGORIES` property, de-duplicated in order.
 *
 * `getFirstPropertyValue` returns only the first value of the first property,
 * which quietly drops every tag but one; a component may also carry more than
 * one `CATEGORIES` line, and different clients split them differently.
 */
function readCategories(comp: ICAL.Component): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prop of comp.getAllProperties('categories')) {
    for (const raw of prop.getValues()) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (value === '' || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * `UID` of the parent task.
 *
 * RFC 5545 makes `PARENT` the default `RELTYPE`, so a bare `RELATED-TO` is a
 * parent link and is treated as one. `SIBLING` and `CHILD` relations are left
 * alone: the Tasks app builds its hierarchy from parent links only.
 */
function readParentUid(comp: ICAL.Component): string | undefined {
  for (const prop of comp.getAllProperties('related-to')) {
    const reltype = prop.getParameter('reltype');
    const kind = typeof reltype === 'string' ? reltype.toUpperCase() : 'PARENT';
    if (kind !== 'PARENT') continue;
    const value = prop.getFirstValue();
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function readStatus(comp: ICAL.Component): TaskStatus {
  const raw = readString(comp, 'status');
  if (raw === undefined) return 'NEEDS-ACTION';
  const upper = raw.toUpperCase() as TaskStatus;
  return TASK_STATUSES.includes(upper) ? upper : 'NEEDS-ACTION';
}

/** UTC ISO-8601 rendering of a timestamp property, for `created` / `last-modified`. */
function readTimestamp(comp: ICAL.Component, name: string): string | undefined {
  const value = comp.getFirstPropertyValue(name);
  if (!(value instanceof ICAL.Time)) return undefined;
  return value.toJSDate().toISOString();
}

/**
 * Locate the `VTODO` that represents the task itself.
 *
 * One calendar object holds a whole recurring series: the master component plus
 * one override per modified occurrence, distinguished by `RECURRENCE-ID`. The
 * master is the task; an override is a single occurrence of it.
 */
export function findMasterVtodo(calendar: ICAL.Component): ICAL.Component | undefined {
  const todos = calendar.getAllSubcomponents('vtodo');
  if (todos.length === 0) return undefined;
  return todos.find((t) => !t.hasProperty('recurrence-id')) ?? todos[0];
}

/** Parse a calendar object, returning its root component. */
export function parseCalendar(ics: string): ICAL.Component {
  try {
    return ICAL.Component.fromString(ics);
  } catch (err) {
    throw new IcalError(
      `Could not parse the iCalendar data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Map one calendar object to a {@link Task}.
 *
 * Returns null when the object holds no `VTODO` — Nextcloud keeps tasks and
 * events in the same collection, so an event can be returned by a query that
 * was not selective enough.
 */
export function taskFromIcs(
  ics: string,
  context: { href: string; etag?: string; list: string },
): Task | null {
  const calendar = parseCalendar(ics);
  const vtodo = findMasterVtodo(calendar);
  if (!vtodo) return null;

  const uid = readString(vtodo, 'uid');
  if (!uid) {
    throw new IcalError(`The task at ${context.href} has no UID and cannot be addressed.`);
  }

  const rrule = vtodo.getFirstProperty('rrule');

  return {
    uid,
    href: context.href,
    ...(context.etag ? { etag: context.etag } : {}),
    list: context.list,
    summary: readString(vtodo, 'summary'),
    description: readString(vtodo, 'description'),
    status: readStatus(vtodo),
    completed: readDate(vtodo, 'completed'),
    percentComplete: readInt(vtodo, 'percent-complete'),
    priority: readInt(vtodo, 'priority') || undefined,
    due: readDate(vtodo, 'due'),
    start: readDate(vtodo, 'dtstart'),
    location: readString(vtodo, 'location'),
    categories: readCategories(vtodo),
    parentUid: readParentUid(vtodo),
    created: readTimestamp(vtodo, 'created'),
    lastModified: readTimestamp(vtodo, 'last-modified'),
    pinned: readBooleanish(vtodo, 'x-pinned'),
    hideSubtasks: readBooleanish(vtodo, 'x-oc-hidesubtasks'),
    sortOrder: readInt(vtodo, 'x-apple-sort-order'),
    recurrenceRule: rrule ? rrule.getFirstValue()?.toString() : undefined,
    alarmCount: vtodo.getAllSubcomponents('valarm').length,
  };
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

/**
 * Fields a caller may set on a task.
 *
 * `null` clears a property; `undefined` leaves it as it is. The distinction
 * matters on update: "no due date given" and "remove the due date" are
 * different requests, and collapsing them makes one of them unexpressible.
 */
export interface TaskEdits {
  summary?: string;
  description?: string | null;
  status?: TaskStatus;
  percentComplete?: number | null;
  priority?: number | null;
  due?: string | null;
  dueTimezone?: string;
  start?: string | null;
  startTimezone?: string;
  location?: string | null;
  categories?: string[] | null;
  parentUid?: string | null;
  pinned?: boolean | null;
  hideSubtasks?: boolean | null;
  sortOrder?: number | null;
}

function setOrRemove(comp: ICAL.Component, name: string, value: string | number | null): void {
  if (value === null || value === '') {
    comp.removeAllProperties(name);
    return;
  }
  comp.updatePropertyWithValue(name, value);
}

function setDate(
  comp: ICAL.Component,
  name: string,
  value: string | null,
  timezone: string | undefined,
): void {
  if (value === null || value === '') {
    comp.removeAllProperties(name);
    return;
  }
  const time = parseDateInput(value, timezone);
  // Replaced wholesale rather than mutated: an existing property may carry a
  // TZID or VALUE parameter from another client that no longer applies.
  comp.removeAllProperties(name);
  comp.addPropertyWithValue(name, time);
}

/**
 * Apply edits to a `VTODO` in place.
 *
 * Editing the parsed component rather than rebuilding it is what keeps this
 * server safe to point at a shared task list: `RRULE`, `VALARM`, `ATTENDEE`,
 * `GEO` and every X-property written by DAVx5, Apple Reminders or Thunderbird
 * pass through a write untouched, because nothing here removes what it does
 * not recognise.
 */
export function applyEdits(vtodo: ICAL.Component, edits: TaskEdits): void {
  if (edits.summary !== undefined) setOrRemove(vtodo, 'summary', edits.summary);
  if (edits.description !== undefined) setOrRemove(vtodo, 'description', edits.description);
  if (edits.location !== undefined) setOrRemove(vtodo, 'location', edits.location);

  if (edits.status !== undefined) {
    vtodo.updatePropertyWithValue('status', edits.status);
    if (edits.status === 'COMPLETED') {
      if (!vtodo.hasProperty('completed')) vtodo.addPropertyWithValue('completed', nowUtc());
      if (edits.percentComplete === undefined) {
        vtodo.updatePropertyWithValue('percent-complete', 100);
      }
    } else {
      // A task that is not complete has no completion time; leaving a stale one
      // makes the Tasks UI show it as done in some views and not in others.
      vtodo.removeAllProperties('completed');
      if (edits.percentComplete === undefined && readInt(vtodo, 'percent-complete') === 100) {
        vtodo.removeAllProperties('percent-complete');
      }
    }
  }

  if (edits.percentComplete !== undefined) {
    setOrRemove(vtodo, 'percent-complete', edits.percentComplete);
  }
  if (edits.priority !== undefined) {
    // PRIORITY:0 is "undefined priority" in RFC 5545, so it is written as an
    // absent property rather than a zero the Tasks UI would have to interpret.
    setOrRemove(vtodo, 'priority', edits.priority === 0 ? null : edits.priority);
  }

  if (edits.due !== undefined) setDate(vtodo, 'due', edits.due, edits.dueTimezone);
  if (edits.start !== undefined) setDate(vtodo, 'dtstart', edits.start, edits.startTimezone);

  if (edits.categories !== undefined) {
    vtodo.removeAllProperties('categories');
    const values = (edits.categories ?? []).map((c) => c.trim()).filter((c) => c !== '');
    if (values.length > 0) {
      // `new ICAL.Property(name, component)` only associates the component for
      // design lookup; the property is not on it until it is added.
      const prop = new ICAL.Property('categories', vtodo);
      prop.setValues(values);
      vtodo.addProperty(prop);
    }
  }

  if (edits.parentUid !== undefined) {
    // Only parent links are rewritten; a SIBLING or CHILD relation another
    // client created is left in place.
    for (const prop of vtodo.getAllProperties('related-to')) {
      const reltype = prop.getParameter('reltype');
      const kind = typeof reltype === 'string' ? reltype.toUpperCase() : 'PARENT';
      if (kind === 'PARENT') vtodo.removeProperty(prop);
    }
    if (edits.parentUid !== null && edits.parentUid !== '') {
      const prop = new ICAL.Property('related-to', vtodo);
      prop.setParameter('reltype', 'PARENT');
      prop.setValue(edits.parentUid);
      vtodo.addProperty(prop);
    }
  }

  if (edits.pinned !== undefined) {
    setOrRemove(vtodo, 'x-pinned', edits.pinned === null ? null : String(edits.pinned));
  }
  if (edits.hideSubtasks !== undefined) {
    setOrRemove(vtodo, 'x-oc-hidesubtasks', edits.hideSubtasks === null ? null : edits.hideSubtasks ? '1' : '0');
  }
  if (edits.sortOrder !== undefined) {
    setOrRemove(vtodo, 'x-apple-sort-order', edits.sortOrder);
  }

  touch(vtodo);
}

/** Stamp a component as modified now. */
export function touch(vtodo: ICAL.Component): void {
  const now = nowUtc();
  vtodo.updatePropertyWithValue('dtstamp', now);
  vtodo.updatePropertyWithValue('last-modified', now);
}

/** Build a complete calendar object for a new task. */
export function buildTaskIcs(uid: string, edits: TaskEdits): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.updatePropertyWithValue('version', '2.0');
  calendar.updatePropertyWithValue('prodid', PRODID);
  calendar.updatePropertyWithValue('calscale', 'GREGORIAN');

  const vtodo = new ICAL.Component('vtodo');
  calendar.addSubcomponent(vtodo);
  vtodo.updatePropertyWithValue('uid', uid);
  vtodo.updatePropertyWithValue('created', nowUtc());
  if (edits.status === undefined) vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');

  applyEdits(vtodo, edits);
  return calendar.toString();
}

/** Re-serialise a calendar object, with CRLF line endings as RFC 5545 requires. */
export function serializeCalendar(calendar: ICAL.Component): string {
  return calendar.toString().replace(/\r?\n/g, '\r\n');
}
