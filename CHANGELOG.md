# Changelog

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
