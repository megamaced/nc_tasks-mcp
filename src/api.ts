import { randomUUID } from 'node:crypto';

import {
  discoverCalendarHome,
  hrefToUri,
  listTaskLists,
  multigetTasks,
  queryTasks,
  type CalendarObject,
} from './caldav.js';
import { encodeSegment, HttpError, type NextcloudClient } from './http.js';
import {
  applyEdits,
  buildTaskIcs,
  findMasterVtodo,
  IcalError,
  parseCalendar,
  parseDateInput,
  serializeCalendar,
  taskFromIcs,
  wallClockToUtcMs,
  type TaskEdits,
} from './ical.js';
import type { Task, TaskDate, TaskList, TaskStatus, TaskTreeNode } from './types.js';

/** A request that named something the server does not have. */
export class NotFoundError extends Error {
  constructor(
    message: string,
    public readonly hint = '',
  ) {
    super(hint ? `${message} [${hint}]` : message);
    this.name = 'NotFoundError';
  }
}

/** A request the server would accept but that would lose data. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}

/** A reference that identified more than one task. */
export class AmbiguousError extends Error {
  constructor(
    uid: string,
    public readonly lists: readonly string[],
  ) {
    super(
      `The uid "${uid}" exists in ${lists.length} task lists: ${lists.join(', ')}. ` +
        '[Pass list to say which one you mean. Refusing rather than picking, because ' +
        'the choice would otherwise decide which task gets changed or deleted.]',
    );
    this.name = 'AmbiguousError';
  }
}

export interface ListTasksOptions {
  /** Task list URI or display name. Omitted means every list. */
  list?: string;
  includeCompleted?: boolean;
  /** Keep only these statuses. Applied after `includeCompleted`. */
  status?: readonly TaskStatus[];
  /** Keep tasks whose due date is strictly before this instant. */
  dueBefore?: string;
  /** Keep tasks whose due date is at or after this instant. */
  dueAfter?: string;
  /** Keep tasks with no due date at all. Ignored unless a due bound is set. */
  includeUndated?: boolean;
  /** Keep tasks carrying every one of these tags (case-insensitive). */
  tags?: readonly string[];
  /** Keep only children of this task; `'none'` keeps only top-level tasks. */
  parentUid?: string;
  /** Case-insensitive substring match over summary, description and location. */
  search?: string;
  /** Largest number of tasks to return, after filtering and sorting. */
  limit?: number;
}

/** A task list together with the tasks read from it. */
interface ListedTasks {
  list: TaskList;
  tasks: Task[];
}

/**
 * Operations on Nextcloud Tasks, over CalDAV.
 *
 * The calendar home is discovered once and reused; the set of task lists is
 * not cached, because a list created or shared in the web UI has to show up
 * without restarting the server, and a `PROPFIND` on one collection is cheap
 * next to the report that follows it.
 */
export class TasksApi {
  private homePromise: Promise<string> | undefined;

  constructor(
    private readonly client: NextcloudClient,
    private readonly defaultList?: string,
  ) {}

  /** Path of the collection holding this user's calendars. Discovered once. */
  async calendarHome(): Promise<string> {
    // Stored as the promise, not the value, so concurrent callers share one
    // discovery round-trip instead of racing to repeat it.
    this.homePromise ??= discoverCalendarHome(this.client);
    try {
      return await this.homePromise;
    } catch (err) {
      this.homePromise = undefined; // Let the next call try again.
      throw err;
    }
  }

  /** Every collection in the calendar home that can hold tasks. */
  async taskLists(): Promise<TaskList[]> {
    return listTaskLists(this.client, await this.calendarHome());
  }

  /**
   * Resolve a caller's task-list reference to a list.
   *
   * Matched against the URI first and the display name second, both
   * case-insensitively. The URI wins because it is the stable handle: two lists
   * may share a display name, and a rename changes one without changing the
   * other.
   */
  async resolveList(ref?: string): Promise<TaskList> {
    const lists = await this.taskLists();
    if (lists.length === 0) {
      throw new NotFoundError(
        'This account has no task lists.',
        'Create one in the Nextcloud Tasks app, then retry.',
      );
    }

    const wanted = (ref ?? this.defaultList)?.trim();
    if (!wanted) {
      if (lists.length === 1) return lists[0]!;
      throw new NotFoundError(
        `This account has ${lists.length} task lists, so one has to be named.`,
        `Pass list, or set NEXTCLOUD_DEFAULT_TASK_LIST. Available: ${describeLists(lists)}`,
      );
    }

    const lowered = wanted.toLowerCase();
    const byUri = lists.find((l) => l.uri.toLowerCase() === lowered);
    if (byUri) return byUri;

    const byName = lists.filter((l) => l.displayName.toLowerCase() === lowered);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new NotFoundError(
        `"${wanted}" matches ${byName.length} task lists by name.`,
        `Use the uri instead: ${byName.map((l) => l.uri).join(', ')}`,
      );
    }

    throw new NotFoundError(
      `No task list matches "${wanted}".`,
      `Available: ${describeLists(lists)}`,
    );
  }

  /** As {@link resolveList}, but refuses a list that cannot be written to. */
  async resolveWritableList(ref?: string): Promise<TaskList> {
    const list = await this.resolveList(ref);
    if (list.readOnly) {
      throw new UnsupportedError(
        `The task list "${list.displayName}" (${list.uri}) is shared with you read-only, ` +
          'so it cannot be changed from here.',
      );
    }
    return list;
  }

  /** Read and filter tasks. */
  async listTasks(opts: ListTasksOptions = {}): Promise<{ lists: TaskList[]; tasks: Task[] }> {
    const lists = opts.list ? [await this.resolveList(opts.list)] : await this.taskLists();

    // One report per list, in parallel: they are independent reads, and a
    // serial loop makes "what is on my plate" scale with the number of lists.
    const results = await Promise.all(
      lists.map(async (list): Promise<ListedTasks> => {
        const objects = await queryTasks(this.client, list.href, {
          excludeCompleted: opts.includeCompleted === false || opts.includeCompleted === undefined,
        });
        return { list, tasks: toTasks(objects, list.uri) };
      }),
    );

    let tasks = results.flatMap((r) => r.tasks);
    tasks = applyFilters(tasks, opts);
    tasks.sort(compareTasks);
    if (opts.limit !== undefined && tasks.length > opts.limit) {
      tasks = tasks.slice(0, opts.limit);
    }
    return { lists, tasks };
  }

  /**
   * Find one task by UID.
   *
   * With no list to go on, every list is queried — but by UID, so each report
   * matches at most one object and the cost is a round-trip per list rather
   * than a download of every task in the account.
   *
   * A UID is only unique *within* a list, so searching every list can find more
   * than one. That is not hypothetical: an interrupted `move_task` deliberately
   * leaves both copies in place. Taking the first match would make task-list
   * ordering decide which task an update or a delete lands on, so an ambiguous
   * UID is refused instead.
   */
  async findTask(uid: string, listRef?: string): Promise<{ task: Task; list: TaskList }> {
    const candidates = listRef ? [await this.resolveList(listRef)] : await this.taskLists();

    const found = await Promise.all(
      candidates.map(async (list) => {
        const objects = await queryTasks(this.client, list.href, { uid });
        const tasks = toTasks(objects, list.uri).filter((t) => t.uid === uid);
        return tasks.length > 0 ? { task: tasks[0]!, list } : null;
      }),
    );

    const hits = found.filter((f): f is { task: Task; list: TaskList } => f !== null);
    if (hits.length === 0) {
      throw new NotFoundError(
        `No task with uid "${uid}"${listRef ? ` in ${listRef}` : ''}.`,
        'Use list_tasks to find the uid, or pass a different list.',
      );
    }
    if (hits.length > 1) {
      throw new AmbiguousError(
        uid,
        hits.map((h) => h.list.uri),
      );
    }
    return hits[0]!;
  }

  /** Create a task and return it as stored. */
  async createTask(listRef: string | undefined, edits: TaskEdits): Promise<Task> {
    const list = await this.resolveWritableList(listRef);
    if (edits.parentUid) await this.assertParentExists(edits.parentUid, list);

    const uid = randomUUID();
    const href = `${ensureTrailingSlash(list.href)}${encodeSegment(uid)}.ics`;
    const ics = buildTaskIcs(uid, edits);

    // If-None-Match: * turns a UID collision into a refusal rather than an
    // overwrite of somebody else's task.
    const res = await this.client.putCalendarObject(href, ics, { mustNotExist: true });
    return this.readBack(href, list, uid, res.etag, ics);
  }

  /** Apply edits to an existing task and return it as stored. */
  async updateTask(
    uid: string,
    listRef: string | undefined,
    edits: TaskEdits,
    etag?: string,
  ): Promise<Task> {
    const { task, list } = await this.findTask(uid, listRef);
    if (list.readOnly) {
      throw new UnsupportedError(
        `The task list "${list.displayName}" (${list.uri}) is shared with you read-only.`,
      );
    }
    if (edits.parentUid) {
      if (edits.parentUid === uid) {
        throw new UnsupportedError('A task cannot be its own parent.');
      }
      await this.assertParentExists(edits.parentUid, list);
      await this.assertNotDescendant(uid, edits.parentUid, list);
    }
    return this.writeEdits(task, list, edits, etag ?? task.etag);
  }

  /**
   * Mark a task complete or reopen it.
   *
   * A recurring task is refused. RFC 5545 defines completing one occurrence as
   * advancing the series to its next `DUE`, not as closing the task — writing
   * `STATUS:COMPLETED` onto the master instead ends the series permanently, and
   * the occurrences that were still to come cannot be recovered from it.
   */
  async setCompletion(
    uid: string,
    listRef: string | undefined,
    complete: boolean,
    etag?: string,
  ): Promise<Task> {
    const { task, list } = await this.findTask(uid, listRef);
    if (task.recurring) {
      // Either mechanism makes it a series: a rule, explicit dates, or both.
      const how = task.recurrenceRule
        ? task.recurrenceRule
        : `RDATE:${task.recurrenceDates ?? 'explicit dates'}`;
      throw new UnsupportedError(
        `"${task.summary ?? uid}" repeats (${how}). Completing a repeating task has to ` +
          'advance it to its next occurrence, which this server does not do — closing it ' +
          'here would end the series. Complete it in the Nextcloud Tasks app.',
      );
    }
    if (list.readOnly) {
      throw new UnsupportedError(
        `The task list "${list.displayName}" (${list.uri}) is shared with you read-only.`,
      );
    }
    return this.writeEdits(
      task,
      list,
      { status: complete ? 'COMPLETED' : 'NEEDS-ACTION' },
      etag ?? task.etag,
    );
  }

  /** Delete a task. Subtasks are reported but not deleted. */
  async deleteTask(
    uid: string,
    listRef: string | undefined,
    etag?: string,
  ): Promise<{ deleted: Task; orphanedSubtasks: string[] }> {
    const { task, list } = await this.findTask(uid, listRef);
    if (list.readOnly) {
      throw new UnsupportedError(
        `The task list "${list.displayName}" (${list.uri}) is shared with you read-only.`,
      );
    }

    // Read the children before the delete, so the report is accurate.
    const siblings = toTasks(await queryTasks(this.client, list.href), list.uri);
    const orphaned = siblings.filter((t) => t.parentUid === uid).map((t) => t.uid);

    await this.client.deleteCalendarObject(task.href, etag ?? task.etag);
    return { deleted: task, orphanedSubtasks: orphaned };
  }

  /**
   * Move a task to another list.
   *
   * Copy-then-delete, not a DAV `MOVE`. A `MOVE` across calendar collections is
   * not something every CalDAV server supports, and where it is unsupported the
   * failure is a status code rather than a lost task — but the ordering here is
   * what makes the operation safe either way. The copy is written first and
   * then *read back from the destination*; only once it is provably stored is
   * the original deleted. The window where the task exists twice is harmless
   * and recoverable, whereas the window where it exists nowhere is not.
   */
  async moveTask(uid: string, fromRef: string | undefined, toRef: string): Promise<Task> {
    const { task, list: from } = await this.findTask(uid, fromRef);
    const to = await this.resolveWritableList(toRef);
    if (from.uri === to.uri) return task;
    if (from.readOnly) {
      throw new UnsupportedError(
        `The task list "${from.displayName}" (${from.uri}) is shared with you read-only, ` +
          'so tasks cannot be moved out of it.',
      );
    }

    const source = await this.readObject(task.href);
    const href = `${ensureTrailingSlash(to.href)}${encodeSegment(uid)}.ics`;
    await this.client.putCalendarObject(href, source, { mustNotExist: true });

    // A 2xx says the server accepted the write, not that the object is
    // readable at the destination. The delete below is irreversible, so it is
    // gated on reading the copy rather than on the status code alone.
    const [copy] = await multigetTasks(this.client, to.href, [href]);
    const moved = copy?.ics
      ? taskFromIcs(copy.ics, {
          href,
          ...(copy.etag ? { etag: copy.etag } : {}),
          list: to.uri,
        })
      : null;
    if (!moved) {
      throw new UnsupportedError(
        `The copy of "${task.summary ?? uid}" could not be read back from "${to.displayName}", ` +
          `so the original in "${from.displayName}" has been left alone. Nothing was lost; ` +
          `remove the copy at ${href} if one was created.`,
      );
    }

    // Only now is the task safely in two places.
    await this.client.deleteCalendarObject(task.href, task.etag);

    // A parent link points at a UID and is only meaningful within one list, so
    // a subtask left behind now references a task that is no longer beside it.
    return moved;
  }

  /** Every tag in use, with the number of tasks carrying each. */
  async listTags(listRef?: string): Promise<{ tag: string; count: number }[]> {
    const { tasks } = await this.listTasks({
      ...(listRef ? { list: listRef } : {}),
      includeCompleted: true,
    });
    const counts = new Map<string, { tag: string; count: number }>();
    for (const task of tasks) {
      for (const tag of task.categories) {
        const key = tag.toLowerCase();
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Fetch one calendar object's iCalendar body. */
  private async readObject(href: string): Promise<string> {
    const res = await this.client.dav('GET', href, {
      headers: { Accept: 'text/calendar' },
    });
    return res.body;
  }

  /**
   * Re-read a written task, falling back to what was sent.
   *
   * The server may normalise what it stores, so the read-back is what the
   * caller should see. It is not worth failing the whole operation over, since
   * the write itself already succeeded — hence the fallback to the local copy.
   */
  private async readBack(
    href: string,
    list: TaskList,
    uid: string,
    etag: string | null,
    sentIcs: string,
  ): Promise<Task> {
    try {
      const [object] = await multigetTasks(this.client, list.href, [href]);
      if (object?.ics) {
        const task = taskFromIcs(object.ics, {
          href,
          ...(object.etag ? { etag: object.etag } : {}),
          list: list.uri,
        });
        if (task) return task;
      }
    } catch {
      // Fall through to the local copy below.
    }
    const local = taskFromIcs(sentIcs, {
      href,
      ...(etag ? { etag } : {}),
      list: list.uri,
    });
    if (local) return local;
    throw new IcalError(`Wrote task ${uid} but could not read it back as a task.`);
  }

  /** Parse, edit and write back one task, preserving everything not edited. */
  private async writeEdits(
    task: Task,
    list: TaskList,
    edits: TaskEdits,
    etag?: string,
  ): Promise<Task> {
    const ics = await this.readObject(task.href);
    const calendar = parseCalendar(ics);
    const vtodo = findMasterVtodo(calendar);
    if (!vtodo) {
      throw new NotFoundError(`The object at ${task.href} no longer contains a task.`);
    }

    applyEdits(vtodo, edits);
    const updated = serializeCalendar(calendar);
    const res = await this.client.putCalendarObject(task.href, updated, {
      ...(etag ? { etag } : {}),
    });
    return this.readBack(task.href, list, task.uid, res.etag, updated);
  }

  /** Refuse a parent link to a task that is not in the same list. */
  private async assertParentExists(parentUid: string, list: TaskList): Promise<void> {
    const objects = await queryTasks(this.client, list.href, { uid: parentUid });
    const found = toTasks(objects, list.uri).some((t) => t.uid === parentUid);
    if (!found) {
      throw new NotFoundError(
        `No task with uid "${parentUid}" in the list "${list.displayName}".`,
        'A parent task has to be in the same list as its subtask.',
      );
    }
  }

  /**
   * Refuse a parent link that would make the hierarchy a cycle.
   *
   * Walking down from the task being re-parented is cheaper than walking up
   * from the proposed parent, because the whole list is already one report.
   */
  private async assertNotDescendant(
    uid: string,
    proposedParent: string,
    list: TaskList,
  ): Promise<void> {
    const tasks = toTasks(await queryTasks(this.client, list.href), list.uri);
    const childrenOf = new Map<string, string[]>();
    for (const task of tasks) {
      if (!task.parentUid) continue;
      const siblings = childrenOf.get(task.parentUid) ?? [];
      siblings.push(task.uid);
      childrenOf.set(task.parentUid, siblings);
    }

    const seen = new Set<string>([uid]);
    const queue = [...(childrenOf.get(uid) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (next === proposedParent) {
        throw new UnsupportedError(
          `Making "${proposedParent}" the parent of "${uid}" would create a loop: ` +
            'it is already somewhere beneath it.',
        );
      }
      queue.push(...(childrenOf.get(next) ?? []));
    }
  }
}

// -----------------------------------------------------------------------------
// Filtering and shaping
// -----------------------------------------------------------------------------

/** Map calendar objects to tasks, dropping the ones that are not tasks. */
function toTasks(objects: readonly CalendarObject[], listUri: string): Task[] {
  const tasks: Task[] = [];
  for (const object of objects) {
    if (!object.ics) continue;
    let task: Task | null;
    try {
      task = taskFromIcs(object.ics, {
        href: object.href,
        ...(object.etag ? { etag: object.etag } : {}),
        list: listUri,
      });
    } catch {
      // One unreadable object should not make the whole list unreadable. A
      // component this server cannot parse is one another client wrote, and
      // skipping it leaves it untouched rather than risking a rewrite.
      continue;
    }
    if (task) tasks.push(task);
  }
  return tasks;
}

/**
 * Comparable instant for a task date.
 *
 * A whole day sorts at its own midnight, and a floating time is read as though
 * it were UTC — the only reading available without knowing where it will be
 * read, and consistent across every task in a result.
 */
export function dateSortKey(date: TaskDate | undefined): number | undefined {
  if (!date) return undefined;

  // A zoned value is a wall-clock reading in that zone, so it has to be
  // resolved there. Appending Z instead would read 09:00 New York as 09:00 UTC
  // and sort the task five hours early — and filter it into the wrong window.
  if (date.timezone && !date.isDate) {
    const ms = wallClockToUtcMs(date.value, date.timezone);
    if (ms !== undefined) return ms;
  }

  const text = date.isDate ? `${date.value}T00:00:00Z` : date.value;
  const ms = Date.parse(text.endsWith('Z') ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Resolve a caller's date bound to the same scale {@link dateSortKey} uses.
 *
 * Deliberately not `parseDateInput(...).toJSDate()`: ical.js resolves a
 * floating or date-only value against the *process* timezone, so the same
 * `dueBefore: "2026-01-01"` selected a different set of tasks depending on the
 * `TZ` of the machine running the server — a 14-hour spread between London and
 * Tokyo. Bounds are read as UTC, matching how `dateSortKey` reads the floating
 * and whole-day task values they are compared against.
 */
export function dateBoundKey(bound: string, label = 'date bound'): number {
  const text = bound.trim();
  // Validates the grammar and rejects impossible dates; the value is discarded.
  parseDateInput(text);

  const zulu = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)Z$/.exec(text);
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);

  let iso: string;
  if (dateOnly) iso = `${text}T00:00:00Z`;
  else if (zulu) iso = `${zulu[1]}T${padSeconds(zulu[2]!)}Z`;
  else if (local) iso = `${local[1]}T${padSeconds(local[2]!)}Z`;
  else throw new IcalError(`Invalid ${label}: ${bound}`);

  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new IcalError(`Invalid ${label}: ${bound}`);
  return ms;
}

function padSeconds(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

function applyFilters(tasks: Task[], opts: ListTasksOptions): Task[] {
  let out = tasks;

  if (opts.includeCompleted !== true) {
    out = out.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
  }
  if (opts.status && opts.status.length > 0) {
    const wanted = new Set(opts.status);
    out = out.filter((t) => wanted.has(t.status));
  }

  const before = opts.dueBefore === undefined ? undefined : dateBoundKey(opts.dueBefore, 'dueBefore');
  const after = opts.dueAfter === undefined ? undefined : dateBoundKey(opts.dueAfter, 'dueAfter');
  if (before !== undefined || after !== undefined) {
    out = out.filter((t) => {
      const due = dateSortKey(t.due);
      if (due === undefined) return opts.includeUndated === true;
      if (before !== undefined && due >= before) return false;
      if (after !== undefined && due < after) return false;
      return true;
    });
  }

  if (opts.tags && opts.tags.length > 0) {
    const wanted = opts.tags.map((t) => t.toLowerCase());
    out = out.filter((t) => {
      const have = new Set(t.categories.map((c) => c.toLowerCase()));
      return wanted.every((w) => have.has(w));
    });
  }

  if (opts.parentUid !== undefined) {
    out =
      opts.parentUid === 'none'
        ? out.filter((t) => t.parentUid === undefined)
        : out.filter((t) => t.parentUid === opts.parentUid);
  }

  if (opts.search !== undefined && opts.search.trim() !== '') {
    const needle = opts.search.trim().toLowerCase();
    out = out.filter((t) =>
      [t.summary, t.description, t.location].some((field) =>
        field?.toLowerCase().includes(needle),
      ),
    );
  }

  return out;
}

/**
 * Sort order for results: due date first, then priority, then title.
 *
 * Undated tasks sort last rather than first — a list that opens with everything
 * that has no deadline buries the work that does.
 */
function compareTasks(a: Task, b: Task): number {
  const dueA = dateSortKey(a.due) ?? Number.POSITIVE_INFINITY;
  const dueB = dateSortKey(b.due) ?? Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA - dueB;

  // PRIORITY 1 is the highest and 0/absent means undefined, so absent sorts last.
  const prioA = a.priority && a.priority > 0 ? a.priority : 10;
  const prioB = b.priority && b.priority > 0 ? b.priority : 10;
  if (prioA !== prioB) return prioA - prioB;

  return (a.summary ?? '').localeCompare(b.summary ?? '');
}

/**
 * Nest tasks under their parents.
 *
 * Every input task appears exactly once in the output. Three things could
 * otherwise silently drop one, and all three are reachable from real data:
 *
 *  - **UIDs are per-list.** `list_tasks` searches every list by default, so the
 *    same UID can arrive twice from different lists. Keyed by UID alone, the
 *    second would overwrite the first and a task would vanish from the answer
 *    while still being counted. The key is `(list, uid)`, and a parent link
 *    only resolves within the child's own list — which is also the only place
 *    `RELATED-TO` is meaningful.
 *  - **A parent may be missing** — completed, filtered out, or in another list.
 *    The child stays at the top level rather than disappearing.
 *  - **The data may contain a cycle.** This server refuses to create one, but
 *    another CalDAV client or a pair of concurrent updates can still write one.
 *    Every node in a cycle has a parent, so none would ever become a root and
 *    the whole cycle would silently vanish from a read. Cycles are detected and
 *    broken at the node that closes them, which is then surfaced as a root.
 */
export function buildTree(tasks: readonly Task[]): TaskTreeNode[] {
  const key = (list: string, uid: string): string => `${list}\u0000${uid}`;

  const nodes = new Map<string, TaskTreeNode>();
  const order: string[] = [];
  for (const task of tasks) {
    const k = key(task.list, task.uid);
    // A genuine duplicate of the same (list, uid) is a server-side impossibility,
    // but keep the first rather than overwriting, so nothing is lost either way.
    if (nodes.has(k)) continue;
    nodes.set(k, { ...task, subtasks: [] });
    order.push(k);
  }

  const parentOf = (k: string): string | undefined => {
    const node = nodes.get(k);
    if (!node?.parentUid) return undefined;
    const parentKey = key(node.list, node.parentUid);
    return parentKey !== k && nodes.has(parentKey) ? parentKey : undefined;
  };

  /**
   * Whether attaching `k` to its parent would close a loop.
   *
   * Walks up from the parent; if it arrives back at `k`, the link is part of a
   * cycle. Bounded by the node count, so a cycle cannot spin here.
   */
  const closesCycle = (k: string): boolean => {
    let step = parentOf(k);
    for (let guard = 0; step !== undefined && guard <= nodes.size; guard++) {
      if (step === k) return true;
      step = parentOf(step);
    }
    return false;
  };

  const roots: TaskTreeNode[] = [];
  for (const k of order) {
    const node = nodes.get(k)!;
    const parentKey = parentOf(k);
    if (parentKey === undefined || closesCycle(k)) roots.push(node);
    else nodes.get(parentKey)!.subtasks.push(node);
  }
  return roots;
}

function describeLists(lists: readonly TaskList[]): string {
  return lists.map((l) => `${l.uri} ("${l.displayName}")`).join(', ');
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Whether an error means "the resource is not there", for callers that care. */
export function isNotFound(err: unknown): boolean {
  return (err instanceof HttpError && err.status === 404) || err instanceof NotFoundError;
}

/** Re-exported so the tool layer can name the shape it builds. */
export type { TaskEdits };
export { hrefToUri };
