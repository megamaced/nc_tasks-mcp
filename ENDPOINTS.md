# Nextcloud Tasks over CalDAV — Verified Reference

Cross-checked against [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545) (iCalendar), [RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791) (CalDAV), the [Nextcloud Tasks source](https://github.com/nextcloud/tasks), [ical.js](https://github.com/kewisch/ical.js), and a live Nextcloud instance.

All paths are under `/remote.php/dav`. All requests use Basic Auth with an app-password.

## The headline: there is no Tasks API

The Nextcloud Tasks app is a **pure CalDAV client**. It ships no REST endpoint, no OCS endpoint, and no PHP backend of its own — it is a Vue front end over the calendar backend that Nextcloud already had. Every operation here is therefore DAV: `PROPFIND`, `REPORT`, `PUT`, `DELETE` against iCalendar objects.

This is the single biggest difference from the Notes and Collectives APIs, and it sets everything below.

## Gotchas

1. **DAV namespace prefixes are not names.** `DAV:` arrives as `d:`, `D:`, or as the default namespace; CalDAV as `cal:`, `c:` or `C:`. sabre/dav picks them per response and is free to change. Matching on the literal string `<d:href>` works right up until it does not. Resolve by namespace *URI*.

2. **`propstat` is per-status, and a `PROPFIND` reports its misses.** One `<d:response>` carries a 200 block with the properties that exist and a 404 block naming the ones that do not. Both are inside `<d:prop>`. A flat scan reads the 404 block's empty elements as though the server had returned them, which is how an absent `displayname` becomes an empty string that then overwrites a real one.

3. **`calendar-data` is XML-escaped iCalendar.** A task whose description contains `&`, `<` or `]]>` arrives escaped inside the multistatus. Slicing it out with a regex and failing to unescape corrupts the task you are about to write back. Line breaks inside it commonly arrive as `&#13;` too.

4. **An absent `supported-calendar-component-set` means "everything".** RFC 4791 §5.2.3 makes the property optional and its absence permissive. Treating absence as "no VTODO support" hides every task list on a server that does not advertise it.

5. **Tasks and events share collections.** Nextcloud has one collection type. A calendar that supports `VTODO` is a task list whether or not the Tasks UI currently shows it, and a `calendar-query` that is not selective enough returns `VEVENT` objects from the same collection.

6. **Calendar subscriptions appear in the calendar home.** They carry `{http://calendarserver.org/ns/}subscribed` in their `resourcetype`. They are read-only mirrors of somebody else's remote feed and cannot hold a task you create.

7. **`RELATED-TO` defaults to `RELTYPE=PARENT`.** RFC 5545 §3.2.15 sets the default, so a bare `RELATED-TO:some-uid` *is* a parent link. Requiring the explicit parameter drops the hierarchy written by clients that rely on the default. `SIBLING` and `CHILD` relations exist and must not be rewritten when re-parenting.

8. **`PRIORITY:0` means "undefined", not "lowest".** RFC 5545 §3.8.1.9: 1 is the highest priority, 9 the lowest, 0 undefined. Writing a literal `PRIORITY:0` is not the same as omitting the property, and the Tasks UI buckets 1–4 as high, 5 as medium, 6–9 as low.

9. **Completing a recurring `VTODO` is not "set STATUS:COMPLETED".** For a repeating task the defined behaviour is to advance the series to its next `DUE`. Writing `STATUS:COMPLETED` onto the master component ends the series permanently, and the occurrences that were still to come cannot be recovered from it. `tasks-mcp` refuses rather than guesses.

10. **One calendar object can hold a whole series.** The master component plus one override per modified occurrence, distinguished by `RECURRENCE-ID`. `getAllSubcomponents('vtodo')[0]` is not reliably the task — the master is the one *without* a `RECURRENCE-ID`.

11. **Nextcloud's own X-properties disagree on how to spell a boolean.** From the Tasks app's `src/models/task.js`: `X-OC-HIDESUBTASKS` and `X-OC-HIDECOMPLETEDSUBTASKS` are written `1`/`0`, while `X-PINNED` is written `true`/`false`. `X-APPLE-SORT-ORDER` carries the manual sort position. Accept both spellings on read; anything else is better treated as absent than as false.

12. **UIDs are scoped to a list, and so are parent links.** `RELATED-TO` names a UID with no collection qualifier, so it only resolves within one task list. Moving a parent without its subtasks leaves the subtasks pointing at a task that is no longer beside them — the link does not follow across lists.

13. **`time-range` on `VTODO` is not a due-date filter.** RFC 4791 §9.9 resolves it against `DTSTART`, `DUE`, `DURATION`, `COMPLETED` *and* `CREATED` in combination, with distinct rules for each combination present. It is a well-defined filter, but it is not "tasks due in this window", which is what a caller asking for a due-date window means. Filter due dates client-side.

14. **Etags can be weak.** A `W/"abc"` validator sent back as-is in `If-Match` is not the validator the server issued — `If-Match` requires a strong comparison. Strip the `W/`.

15. **A 2xx on `PUT` is not proof the object is readable.** It says the write was accepted. Where the next step is irreversible — the delete half of a move — gate it on reading the copy back, not on the status code.

## ical.js specifics

These cost real debugging time and are not obvious from the API surface.

16. **`getFirstPropertyValue('categories')` returns one tag.** It returns the first value of the first property. A `VTODO` may carry `CATEGORIES:work,urgent` *and* a second `CATEGORIES:q1` line, and different clients split them differently. Iterate `getAllProperties('categories')` and call `getValues()` on each, or silently drop every tag but one.

17. **`new ICAL.Property(name, component)` does not add the property.** The second argument associates the component for design-set lookup only. Without an explicit `component.addProperty(prop)` the property is constructed, populated, and discarded — the write silently does nothing. This is the one bug in `tasks-mcp` that reached a live server before a test caught it.

18. **`TZID` must be read from the parameter, not from `value.zone`.** ical.js only resolves a zone it has been handed a matching `VTIMEZONE` for. Nextcloud does not always include one, and without it every zoned time parses as `floating` — so `DUE;TZID=Europe/London:20260110T170000` reads back with its zone silently gone. `property.getParameter('tzid')` has it either way.

19. **Writing a `TZID` without a matching `VTIMEZONE` produces non-conformant iCalendar.** ical.js cannot generate one for an arbitrary zone without a bundled tz database. `tasks-mcp` therefore resolves a zoned wall-clock time to its UTC instant and stores that: exact, unambiguous, and rendered in the reader's own zone by every client.

20. **`RDATE` defines a series without an `RRULE`.** RFC 5545 §3.8.5.2 lets recurrence be expressed entirely as explicit dates. A recurrence guard that looks only for `RRULE` waves those through, and completing one closes the whole series — the exact outcome the guard exists to prevent.

21. **`DUE`, `DTSTART` and `DURATION` constrain each other.** RFC 5545 §3.6.2: `DUE` and `DTSTART` must share a value type, `DUE` must be later than `DTSTART`, and `DUE` and `DURATION` must not both appear. Each property can be individually valid while the combination is not — an all-day start with a timed due date has no agreed meaning, and clients are free to read it differently.

22. **`ICAL.Time` normalises rather than rejects.** `2026-02-30` becomes 2 March, `2026-13-01` becomes January 2027, and `25:00:00` becomes 01:00 the next day. `Date.UTC` does the same. A caller gets a successful write back carrying a date it never asked for, which is silent corruption wearing a success message. Validate the calendar fields before conversion.

    The subtle case is the **leap second**: RFC 5545 permits `:60`, so `2016-12-31T23:59:60Z` is a *legal* spelling — but `ICAL.Time` and `Date` are both POSIX-time based, where leap seconds do not exist, and it silently becomes `20170101T000000Z`. `Date.parse` rejects it outright, so a validator that allows `:60` will also disagree with itself depending on which path reads the value. There is nothing to preserve it with short of carrying the raw text alongside every parsed value, and the first other client or server to touch the task would normalise it anyway, so refusing is the only option that does not lie.

23. **A wall-clock time can fail to exist.** The hour a spring-forward transition deletes — 01:30 on 2026-03-29 in `Europe/London` — has no instant, and offset arithmetic lands on a different time instead. The only way to notice is to convert, read the result back in the same zone, and check it still shows the reading that was asked for. Fall-back times, which happen twice, do have an answer; pick one deliberately and document it.

24. **`toJSDate()` resolves floating and whole-day values against the process timezone.** `2026-01-01T12:00:00` becomes `17:00Z` under `TZ=America/New_York` and `03:00Z` under `TZ=Asia/Tokyo`. Any filter built on it silently selects a different set of tasks depending on which machine the server runs on. Convert floating and date-only values explicitly instead.

25. **Node's `fetch` follows redirects anywhere, including cross-origin.** A DAV endpoint that answers with a 302 can point the process at `localhost`, a cloud metadata service, or anything else the host can reach, and the response comes back through tool output. Node strips `Authorization` across origins, which protects the credential but neither prevents the request nor stops the disclosure — and a body-carrying method forwards its body. Use `redirect: 'manual'` and an explicit same-origin policy.

## Discovery

| Step | Method | Path | Property |
| --- | --- | --- | --- |
| 1 | `PROPFIND` Depth 0 | `/remote.php/dav/` | `<d:current-user-principal>` |
| 2 | `PROPFIND` Depth 0 | the principal href | `<c:calendar-home-set>` |
| 3 | `PROPFIND` Depth 1 | the calendar home | the table below |

The conventional layout is `/remote.php/dav/calendars/{user}/`, and that is the correct fallback when a reverse proxy blocks `PROPFIND` at the DAV root — but it is a fallback, not a substitute. A deployment behind a path prefix or with a non-default principal path answers discovery correctly and a guess incorrectly.

## Collection properties

| Property | Namespace | Use |
| --- | --- | --- |
| `resourcetype` | `DAV:` | Must contain `{urn:ietf:params:xml:ns:caldav}calendar`; must not contain `{http://calendarserver.org/ns/}subscribed`. |
| `displayname` | `DAV:` | Shown in the Tasks UI. Not unique, not stable across renames. |
| `current-user-privilege-set` | `DAV:` | `write` / `write-content` / `all` means writable. Absent means writable — the property is optional. |
| `supported-calendar-component-set` | CalDAV | `<c:comp name="VTODO"/>` marks a task list. Absent means all components. |
| `getctag` | `http://calendarserver.org/ns/` | Changes when anything in the collection changes. A cheap "has anything changed?". |
| `calendar-color` | `http://apple.com/ns/ical/` | `#rrggbb`. |
| `calendar-order` | `http://apple.com/ns/ical/` | Sidebar sort position. |

The stable handle for a list is the **last path segment of its href**, percent-decoded — Nextcloud derives it at creation and never changes it, whereas `displayname` follows every rename.

## Requests

| Operation | Method | Target | Notes |
| --- | --- | --- | --- |
| List tasks | `REPORT` Depth 1 | collection | `calendar-query` filtered `VCALENDAR` → `VTODO`. Returns `getetag` + `calendar-data`. |
| Exclude completed | — | — | `<c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter>`. A payload reduction only: a task may carry `STATUS:COMPLETED` with no `COMPLETED` timestamp, so filter again after parsing. |
| Find by UID | `REPORT` Depth 1 | collection | `<c:prop-filter name="UID"><c:text-match collation="i;octet">` — a UID is opaque, so the default case-insensitive collation could match a different task. |
| Fetch specific | `REPORT` Depth 1 | collection | `calendar-multiget` with `<d:href>` per object. |
| Read one | `GET` | object | `Accept: text/calendar`. Returns the raw `.ics`. |
| Create | `PUT` | object | `Content-Type: text/calendar; charset=utf-8`, `If-None-Match: *` so a UID collision is refused rather than overwriting. |
| Update | `PUT` | object | `If-Match: <etag>` for optimistic concurrency. 412 on conflict, with **no body** — unlike the Notes API, there is nothing to merge against without a second round-trip. |
| Delete | `DELETE` | object | `If-Match: <etag>` optional. |

`PROPFIND` and `REPORT` succeed with **HTTP 207 Multi-Status**, not 200. Both are reads and may be safely replayed on a transient failure; `PUT` and `DELETE` may not, whatever HTTP's idempotency guarantee says, because that guarantee is about server state and the *response* is what gets reported back.

## Task properties read and written

| Property | Maps to |
| --- | --- |
| `UID` | `uid` — the handle every tool takes |
| `SUMMARY` | `summary` |
| `DESCRIPTION` | `description` |
| `STATUS` | `status` — `NEEDS-ACTION`, `IN-PROCESS`, `COMPLETED`, `CANCELLED`; defaults to `NEEDS-ACTION` |
| `COMPLETED` | `completed` |
| `PERCENT-COMPLETE` | `percentComplete` |
| `PRIORITY` | `priority` (see gotcha 8) |
| `DUE` | `due` |
| `DTSTART` | `start` |
| `LOCATION` | `location` |
| `CATEGORIES` | `categories` (see gotcha 16) |
| `RELATED-TO;RELTYPE=PARENT` | `parentUid` (see gotcha 7) |
| `CREATED`, `LAST-MODIFIED` | `created`, `lastModified` |
| `X-PINNED` | `pinned` |
| `X-OC-HIDESUBTASKS` | `hideSubtasks` |
| `X-APPLE-SORT-ORDER` | `sortOrder` |
| `RRULE` | `recurrenceRule` — reported, not editable (see gotcha 9) |
| `VALARM` | `alarmCount` — counted, not editable |

Everything else in the component — `ATTENDEE`, `GEO`, `CLASS`, `URL`, `SEQUENCE`, `VALARM` bodies, and any X-property written by DAVx5, Apple Reminders or Thunderbird — **survives a write untouched**, because updates edit the parsed component in place rather than rebuilding it from a model. Nothing removes what it does not recognise.

## Date representation

iCalendar draws a distinction a single ISO string cannot carry, and flattening it is the classic way to move an all-day task onto the wrong day:

| Form | On the wire | Reported as |
| --- | --- | --- |
| Whole day | `DUE;VALUE=DATE:20260301` | `{ value: "2026-03-01", isDate: true }` |
| UTC instant | `DUE:20260301T143000Z` | `{ value: "2026-03-01T14:30:00Z", isDate: false }` |
| Zoned | `DUE;TZID=Europe/London:20260301T143000` | `{ value: "2026-03-01T14:30:00", isDate: false, timezone: "Europe/London" }` |
| Floating | `DUE:20260301T143000` | `{ value: "2026-03-01T14:30:00", isDate: false }` |

A floating time means the same wall-clock reading in every zone. It is preserved rather than guessed at.
