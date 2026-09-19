# Changelog

## v0.1.1 — Review fixes

Twelve issues raised against v0.1.0 (#2–#13), all confirmed against the code and fixed.

### Security

- **Cross-origin redirects are no longer followed** (#10). Node's `fetch` follows redirects anywhere by default, so a malicious or compromised Nextcloud endpoint could redirect a DAV request to any service the host can reach — `localhost`, a cloud metadata endpoint — and have the response returned through tool output, with a body-carrying method forwarding task content too. Redirects are now resolved against an explicit same-origin policy (plus an http→https upgrade on the same host), bounded at five hops. Covered by tests that assert the redirect target is never contacted.
- **Dependabot alerts and security updates enabled**, and a weekly CodeQL workflow added with pinned action SHAs and least-privilege permissions (#13).

### Correctness

- **An ambiguous uid is refused** (#2). UIDs are per-list, so a uid-only lookup across lists could match more than one task — reachable after an interrupted `move_task`, which deliberately leaves both copies. The first match used to win, making task-list ordering decide which task an update or `delete_task` landed on. It now reports the matching lists and asks for one.
- **Nested results no longer drop or misparent tasks** (#3). `buildTree` keyed nodes by uid alone, so the same uid from two lists collided and a task vanished from the output while still being counted, and a parent link could resolve to a task in a different list. The key is now `(list, uid)`, and parents resolve only within the child's own list.
- **A parent cycle no longer erases the tasks in it** (#4). Every node in a cycle has a parent, so none became a root and the whole cycle disappeared from a read. This server refuses to create a cycle, but another CalDAV client can still write one. Cycles are now detected and broken at the closing node, which is surfaced as a root.
- **Impossible dates are rejected, not normalised** (#5). `ICAL.Time` and `Date.UTC` silently turn `2026-02-30` into 2 March and `25:00:00` into 01:00 the next day, so a caller could get a successful write back carrying a date it never asked for. Calendar fields are validated before conversion, and a wall-clock time a zone skips for daylight saving is rejected by round-tripping the result through the zone.
- **Due-date ordering and filtering no longer depend on the machine** (#6). `dateSortKey` ignored `TZID` and read a zoned value as UTC, and the bound conversion went through `toJSDate()`, which resolves floating and whole-day values against the process timezone — a 14-hour spread between London and Tokyo. Zoned values are resolved in their own zone; floating and whole-day values use the documented UTC convention on both sides of the comparison.
- **RDATE-only recurrence is detected** (#9). The completion guard looked only for `RRULE`, so a series defined by explicit `RDATE`s was accepted and closed — exactly what the guard exists to prevent. Tasks now carry `recurring`, true for either mechanism, alongside `recurrenceRule` and `recurrenceDates`.
- **Contradictory date combinations are rejected** (#8). RFC 5545 requires `DUE` and `DTSTART` to share a value type with `DUE` later than `DTSTART`, and forbids `DUE` with `DURATION`. Each property could be individually valid while the combination was not. Validated when an edit touches a date, so a task another client wrote in an invalid state stays editable in every other respect, and `DURATION` is reported rather than silently deleted.
- **A timezone without its date is an error** (#7). `dueTimezone` alone satisfied the "at least one field" check but was only ever read alongside `due`, so the call succeeded, bumped `DTSTAMP` and `LAST-MODIFIED`, and ignored the only thing asked for.
- **The XML parser rejects character data outside the root** (#12). Text before or after the document element was silently ignored, so a truncated response — or an HTML error page a proxy concatenated onto one — could parse into a plausible tree. A `multistatus` recovered from half a document reports "no tasks", which is indistinguishable from an empty list.

### Documentation

- **`list_tasks` said "newest deadline first" while sorting earliest first** (#11). The description is supplied straight to models, so the wording could invert how results were read.
- `ENDPOINTS.md` gains six verified behaviours (20–25) covering RDATE series, the `DUE`/`DTSTART`/`DURATION` constraints, `ICAL.Time` normalisation, nonexistent wall-clock times, `toJSDate()`'s timezone dependence, and `fetch` redirect behaviour.

Test count is up from 79 to 126, including local HTTP servers that exercise the redirect policy and the ambiguous-uid path end to end.

## v0.1.0 — Initial release

A Model Context Protocol server for Nextcloud Tasks: eleven tools covering task lists, tasks, subtasks and tags over CalDAV.

### Tools

- **Tasks:** `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`, `move_task`
- **Completion:** `complete_task`, `uncomplete_task`
- **Organisation:** `list_task_lists`, `list_tags`
- **Other:** `ping`

Every tool declares the full MCP annotation set, so a client can tell a read from an irreversible delete without parsing descriptions.

### Notable behaviour

- **CalDAV, because there is no alternative.** The Tasks app ships no REST or OCS API — it is a front end over Nextcloud's calendar backend. The server discovers the calendar home through the RFC 4791 chain (`current-user-principal` → `calendar-home-set`), falling back to the conventional path only when a proxy blocks `PROPFIND` at the DAV root.
- **Updates preserve what they do not touch.** Writes edit the parsed `VTODO` in place rather than rebuilding it, so recurrence, reminders, attendees and X-properties written by DAVx5, Apple Reminders or Thunderbird survive untouched. This is what makes the server safe to point at a list that also syncs to a phone.
- **Clearing a field is distinct from omitting it.** `null` removes a property; an absent argument leaves it alone. Collapsing the two makes one of them unexpressible.
- **Date types are preserved.** A whole day, a UTC instant, a zoned time and a floating time are four different things in iCalendar, and flattening them into one timestamp is how an all-day task ends up on the wrong day. A zoned time is resolved to its UTC instant rather than written with a `TZID`, which would be non-conformant without a matching `VTIMEZONE`.
- **Repeating tasks are refused by `complete_task`.** Completing one has to advance the series to its next occurrence; writing `STATUS:COMPLETED` onto the master ends it permanently. Recurrence is reported and preserved, just not editable.
- **`delete_task` does not cascade.** Subtasks are left in place and reported as `orphanedSubtasks`, so nothing is destroyed that was not named.
- **`move_task` proves the copy landed before deleting the original.** A 2xx on `PUT` says the write was accepted, not that the object is readable; the delete is gated on reading the copy back from the destination.
- **Optimistic concurrency throughout.** `get_task` returns an etag; passing it to a write makes it conditional. A CalDAV 412 carries no body, so the error explains how to get the current state rather than pretending to carry it.

`ENDPOINTS.md` documents these and fifteen more behaviours that are not in the published specs.

### Design notes

- **A real XML parser, not regexes.** DAV prefixes are chosen per response, `propstat` blocks are per-status, and `calendar-data` is XML-escaped iCalendar — a flat scan reads properties out of 404 blocks and corrupts task bodies containing `&` or `<`. The parser is deliberately small and does not resolve DTDs or external entities.
- **Only reads are replayed.** HTTP calls `PUT` and `DELETE` idempotent, but that is a guarantee about server state, not about the response — and the response is what gets reported back. A conditional `PUT` that commits and loses its reply returns 412 on replay; a committed `DELETE` returns 404. Both would report failure for a write that succeeded. `REPORT` *is* replayable: CalDAV uses it as a read.
- **Due-date filtering is client-side.** RFC 4791's `time-range` for `VTODO` resolves against `DTSTART`, `DUE`, `DURATION`, `COMPLETED` and `CREATED` in combination — well-defined, but not the "tasks due in this window" a caller means. Server-side filtering is used only to exclude completed tasks, as a payload reduction, with the authoritative filter applied after parsing.
- **UID lookups use an octet collation.** A UID is opaque, so the default case-insensitive text match could return a different task.
