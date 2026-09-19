/**
 * A task list: a CalDAV calendar collection whose supported component set
 * includes `VTODO`.
 *
 * Nextcloud presents calendars and task lists as one underlying collection, so
 * a list that also holds events is still a valid task list. Collections that
 * support only `VEVENT` are filtered out before they ever reach this type.
 */
export interface TaskList {
  /**
   * Last path segment of the collection URL, and the stable handle every tool
   * takes. Unlike the display name it cannot be changed from the Tasks UI.
   */
  uri: string;
  /** Full DAV path of the collection, e.g. `/remote.php/dav/calendars/alice/personal/`. */
  href: string;
  /** Name shown in the Tasks app. Not unique, and not stable across renames. */
  displayName: string;
  /** `#rrggbb` calendar colour, when the server has one set. */
  color?: string;
  /** Sort position in the Tasks sidebar. */
  order?: number;
  /** True when the collection was shared without write permission. */
  readOnly: boolean;
  /**
   * Collection tag: changes whenever anything in the list changes. Useful as a
   * cheap "has anything changed?" check without re-reading every task.
   */
  ctag?: string;
}

/** The four `STATUS` values RFC 5545 defines for a `VTODO`. */
export type TaskStatus = 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'NEEDS-ACTION',
  'IN-PROCESS',
  'COMPLETED',
  'CANCELLED',
];

/**
 * A date or date-time as it appears on a task.
 *
 * iCalendar draws a distinction the ISO string alone cannot carry: `DUE` may be
 * a whole day (`VALUE=DATE`), an instant in a named zone (`TZID=Europe/London`),
 * a UTC instant, or a "floating" local time that means the same wall-clock
 * reading in every zone. Flattening all four into one UTC timestamp is the
 * classic way to move an all-day task onto the wrong day, so the distinction is
 * preserved here and on the way back out.
 */
export interface TaskDate {
  /**
   * `YYYY-MM-DD` for a whole day, `YYYY-MM-DDTHH:MM:SS` for a local or zoned
   * time, or `YYYY-MM-DDTHH:MM:SSZ` for UTC.
   */
  value: string;
  /** True when this is a whole day with no time component. */
  isDate: boolean;
  /** IANA zone from the `TZID` parameter. Absent for UTC, floating and dates. */
  timezone?: string;
}

/**
 * A task, as read from a `VTODO`.
 *
 * Only the fields this server models appear here. Everything else in the
 * component — `RRULE`, `VALARM`, `ATTENDEE`, X-properties written by other
 * clients — survives an update untouched, because writes edit the parsed
 * component in place rather than rebuilding it from this shape.
 */
export interface Task {
  /** iCalendar `UID`. Unique within the list, and the handle tools take. */
  uid: string;
  /** DAV path of the backing `.ics` resource. */
  href: string;
  /** Entity tag of the resource; pass it back to make a write conditional. */
  etag?: string;
  /** `uri` of the task list holding this task. */
  list: string;
  summary?: string;
  description?: string;
  status: TaskStatus;
  /** When the task was completed. Present only for `COMPLETED`. */
  completed?: TaskDate;
  /** `PERCENT-COMPLETE`, 0–100. */
  percentComplete?: number;
  /**
   * `PRIORITY`, 1–9, where 1 is highest. 0 or absent means undefined.
   * The Tasks UI buckets these as high (1–4), medium (5), low (6–9).
   */
  priority?: number;
  due?: TaskDate;
  start?: TaskDate;
  location?: string;
  /** Free-form tags. Shown as "tags" in the Tasks UI, `CATEGORIES` on the wire. */
  categories: string[];
  /** `UID` of the parent task, from `RELATED-TO;RELTYPE=PARENT`. */
  parentUid?: string;
  created?: string;
  lastModified?: string;
  /** Nextcloud's `X-PINNED`. */
  pinned?: boolean;
  /** Nextcloud's `X-OC-HIDESUBTASKS`. */
  hideSubtasks?: boolean;
  /** Manual sort position, from `X-APPLE-SORT-ORDER`. */
  sortOrder?: number;
  /**
   * True when the task repeats, by either mechanism below.
   *
   * This, not `recurrenceRule` alone, is what marks a task as a series.
   * Recurrence can be expressed with explicit dates and no rule at all, and a
   * check that looks only for `RRULE` would wave those through.
   */
  recurring: boolean;
  /**
   * Recurrence rule, verbatim, when the task repeats by rule.
   *
   * Reported so a caller knows not to treat the task as a one-off, but not
   * editable: completing a recurring `VTODO` is defined to advance `DUE` rather
   * than close the task, and getting that wrong silently destroys a repeating
   * series. Edit recurrence in the Tasks UI.
   */
  recurrenceRule?: string;
  /**
   * Explicit recurrence dates from `RDATE`, verbatim, when there are any.
   *
   * RFC 5545 allows a series to be defined entirely by these, with no `RRULE`.
   */
  recurrenceDates?: string;
  /** Number of `VALARM` reminders on the task. Preserved on write, not editable. */
  alarmCount: number;
}

/** A task together with the subtasks nested beneath it. */
export interface TaskTreeNode extends Task {
  subtasks: TaskTreeNode[];
}
