# tasks-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Nextcloud Tasks](https://github.com/nextcloud/tasks) — exposes task lists, tasks, subtasks and tags to Claude and any MCP-compatible client.

## How it works

The Nextcloud Tasks app ships **no REST or OCS API**. It is a Vue front end over Nextcloud's existing calendar backend, so every task is an iCalendar `VTODO` and every operation is CalDAV: `PROPFIND` to discover the calendar home, `REPORT` to query, `PUT` and `DELETE` on individual `.ics` objects.

That makes this server structurally different from the Notes and Collectives ones. It carries its own namespace-aware XML reader for multistatus responses — prefixes are chosen per response by sabre/dav, `propstat` blocks are per-status, and `calendar-data` arrives as XML-escaped iCalendar, none of which survives a regex. [ical.js](https://github.com/kewisch/ical.js) handles the iCalendar layer.

Details and the behaviours that are not in the published specs are in [ENDPOINTS.md](ENDPOINTS.md).

## Tools exposed (11)

- **Tasks:** `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`, `move_task`
- **Completion:** `complete_task`, `uncomplete_task`
- **Organisation:** `list_task_lists`, `list_tags`
- **Other:** `ping`

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can distinguish a read from an irreversible delete without parsing descriptions.

### Updates never clobber what they do not touch

`update_task` edits the parsed `VTODO` in place rather than rebuilding it. Recurrence rules, reminders, attendees, and any X-property written by DAVx5, Apple Reminders or Thunderbird pass through a write untouched — nothing removes what it does not recognise. This is what makes the server safe to point at a task list you also sync to a phone.

Only the fields you pass are changed. Passing `null` clears a field, which is a different request from omitting it: "no due date given" and "remove the due date" are both expressible.

### Concurrency

`get_task` returns the task's `etag`. Passing it back to `update_task`, `complete_task` or `delete_task` makes the write conditional — if the task changed on the server in the meantime, the write is refused. Unlike the Notes API, a CalDAV 412 carries no body, so the error says how to get the current state rather than pretending to carry it.

### Dates

iCalendar distinguishes a whole day from an instant, and both from a floating local time. Flattening them into one UTC timestamp is the standard way to move an all-day task onto the wrong day, so the distinction is preserved in both directions:

| You pass | Stored as |
| --- | --- |
| `"2026-03-01"` | a whole day (`VALUE=DATE`) |
| `"2026-03-01T14:30:00Z"` | a UTC instant |
| `"2026-03-01T14:30:00"` + `dueTimezone: "Europe/London"` | the equivalent UTC instant |
| `"2026-03-01T14:30:00"` alone | a floating time |

A zoned time is converted to UTC rather than written with a `TZID`, because a `TZID` is only valid alongside a matching `VTIMEZONE` and ical.js cannot generate one for an arbitrary zone. The UTC instant is exact and every client renders it in the reader's own zone.

### Subtasks

Subtasks are `RELATED-TO;RELTYPE=PARENT` links. Set `parentUid` on create or update; `list_tasks` with `nest: true` returns the tree. Two constraints come from the format rather than from this server:

- A parent must be in the **same list** as its subtask — `RELATED-TO` names a UID with no collection qualifier, so the link does not resolve across lists. `move_task` moves one task, so move a parent and its subtasks together if you want the hierarchy to survive.
- `delete_task` does **not** cascade. Subtasks are left in place and reported as `orphanedSubtasks`, so nothing is destroyed that was not named.

Re-parenting is checked for cycles, and a task cannot be its own parent.

### Repeating tasks

`complete_task` refuses a task with an `RRULE`. Completing a repeating task has to advance it to its next occurrence; writing `STATUS:COMPLETED` onto the master component instead ends the series permanently, and the occurrences still to come cannot be recovered from it. Recurrence is reported on every task as `recurrenceRule` and preserved through every write — it is just not editable here. Complete or edit repeating tasks in the Tasks UI.

## Install

There is no published npm package. Install the release tarball, which puts the `tasks-mcp` command on your `PATH`:

```bash
# Download tasks-mcp-<version>.tgz from the latest release, then:
npm install -g ./tasks-mcp-<version>.tgz
```

The asset is attached to each [release](https://github.com/megamaced/nc_tasks-mcp/releases/latest).

To build it yourself instead, either pack the same tarball:

```bash
corepack pnpm install
corepack pnpm pack:tarball
npm install -g ./tasks-mcp-<version>.tgz
```

or skip the global install and point the client at the built entry point:

```bash
corepack pnpm install
corepack pnpm build
```

## Configuration

Add to your MCP client config (Claude Code shown). After a global install:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "tasks-mcp",
      "args": [],
      "env": {
        "NEXTCLOUD_URL": "https://your-nextcloud.example.com",
        "NEXTCLOUD_USER": "your-username",
        "NEXTCLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

Or, running from the build directory, with an absolute path to `dist/index.js`:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "node",
      "args": ["/absolute/path/to/nc_tasks-mcp/dist/index.js"],
      "env": {
        "NEXTCLOUD_URL": "https://your-nextcloud.example.com",
        "NEXTCLOUD_USER": "your-username",
        "NEXTCLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

**Generate the app-password** in Nextcloud under Settings > Security > Devices & sessions > "Create new app password". The MCP server only needs an app-password, never your real account password — and you can revoke it without affecting your main login.

## Development

```bash
corepack pnpm install
corepack pnpm dev        # stdio MCP server, point mcp inspector at it
corepack pnpm test       # deterministic unit tests, no Nextcloud required
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build      # tsc -> dist/
```

Required env vars: `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD`.

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXTCLOUD_DEFAULT_TASK_LIST` | unset | List used when a tool needs one and the caller omits it. Matched on uri, then display name. Unnecessary if the account has only one list. |
| `NEXTCLOUD_TIMEOUT_MS` | `60000` | Per-request deadline. Must be a whole number of milliseconds, at most 2147483647. |
| `NEXTCLOUD_MAX_RESPONSE_BYTES` | `20971520` | Largest response body buffered. A `calendar-query` returns every matching task's full iCalendar body in one document, so this scales with list size rather than page size. |
| `DEBUG` | unset | Log each request to stderr. |

## Disclosure

This project was 100% written by AI (Claude), including all source code, tests, CI configuration, and documentation.

## License

MIT — see [LICENSE](LICENSE).

## Related

- [Nextcloud Tasks](https://github.com/nextcloud/tasks)
- [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545) (iCalendar) and [RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791) (CalDAV)
- [nc_notes-mcp](https://github.com/megamaced/nc_notes-mcp) — the same approach for Nextcloud Notes
- [nc_collectives-mcp](https://github.com/megamaced/nc_collectives-mcp) — the same approach for Nextcloud Collectives
- [Model Context Protocol](https://modelcontextprotocol.io)
