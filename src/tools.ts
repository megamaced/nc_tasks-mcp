import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  AmbiguousError,
  buildTree,
  NotFoundError,
  UnsupportedError,
  type TasksApi,
  type TaskEdits,
} from './api.js';
import { ConflictError, HttpError, RedirectRefusedError } from './http.js';
import { IcalError } from './ical.js';
import { TASK_STATUSES, type Task } from './types.js';
import { XmlParseError } from './xml.js';

interface Context {
  api: TasksApi;
  configSummary: string;
}

interface ToolDef<S extends ZodTypeAny> {
  tool: Tool;
  argsSchema: S;
  handler: (args: z.infer<S>, ctx: Context) => Promise<CallToolResult>;
}

const Empty = z.object({}).strict();

/**
 * A boolean argument that tolerates MCP clients which serialise scalars as
 * strings, without the footgun `z.coerce.boolean()` carries: that is just
 * `Boolean(value)`, so every non-empty string — including "false" — becomes
 * `true`. Accept real booleans and the two unambiguous string spellings, and
 * reject anything else so a caller gets an error rather than the inverse of
 * what they asked for.
 */
const Bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/**
 * An integer argument, or the decimal string spelling of one.
 *
 * Not `z.coerce.number()`, which is `Number(value)` and therefore accepts far
 * more than the advertised `integer` schema: `true` and `["1"]` both become
 * `1`, and `"0x10"` becomes `16`. The JSON Schema is the documentation; this is
 * the trust boundary.
 */
const Int = z
  .union([z.number(), z.string().regex(/^-?\d+$/, 'must be a decimal integer')])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isSafeInteger(n), { message: 'must be a whole number' });

/** A task UID: opaque, but never empty or padded. */
const Uid = z
  .string()
  .trim()
  .min(1, 'uid must not be empty')
  .max(512, 'uid is implausibly long');

const StatusEnum = z.enum(TASK_STATUSES as unknown as [string, ...string[]]);

/**
 * A field the caller may clear.
 *
 * `null` means "remove this property", which is a different request from
 * omitting the field. Empty string is folded into `null` because an MCP client
 * that cannot express JSON null still has to be able to clear a description.
 */
const Clearable = <T extends ZodTypeAny>(inner: T) =>
  z.union([inner, z.null(), z.literal('')]).transform((v) => (v === '' ? null : v));

/**
 * Largest JSON result handed back to the client.
 *
 * A result far past this is unusable anyway: it displaces the caller's context
 * rather than informing it. Refusing with guidance beats truncating, which
 * would produce invalid JSON the caller cannot parse.
 */
const MAX_RESULT_BYTES = 1024 * 1024;

function jsonResult(data: unknown, guidance?: string): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_RESULT_BYTES) {
    return errorResult(
      `Result too large: ${size} bytes exceeds the ${MAX_RESULT_BYTES}-byte limit.` +
        (guidance ? ` ${guidance}` : ''),
    );
  }
  return { content: [{ type: 'text', text }] };
}

/**
 * Drop the fields a task does not have.
 *
 * `JSON.stringify` already omits `undefined`, but an empty `categories` array
 * and an `alarmCount` of zero are noise on every task that has neither, and
 * this result goes into a model's context.
 */
function compact(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { ...task };
  if (task.categories.length === 0) delete out.categories;
  if (task.alarmCount === 0) delete out.alarmCount;
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

/** Collect the edit fields shared by create_task and update_task. */
function toEdits(args: Record<string, unknown>): TaskEdits {
  const edits: TaskEdits = {};
  const copy = <K extends keyof TaskEdits>(key: K): void => {
    if (args[key] !== undefined) edits[key] = args[key] as TaskEdits[K];
  };
  copy('summary');
  copy('description');
  copy('status');
  copy('percentComplete');
  copy('priority');
  copy('due');
  copy('dueTimezone');
  copy('start');
  copy('startTimezone');
  copy('location');
  copy('categories');
  copy('parentUid');
  copy('pinned');
  copy('hideSubtasks');
  copy('sortOrder');
  return edits;
}

// Shared JSON Schema fragments for the task fields a caller may set.
const EDIT_PROPERTIES = {
  summary: { type: 'string', description: 'Task title.' },
  description: {
    type: ['string', 'null'],
    description: 'Longer notes. null or "" removes them.',
  },
  status: {
    type: 'string',
    enum: [...TASK_STATUSES],
    description: 'Defaults to NEEDS-ACTION on a new task.',
  },
  percentComplete: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 100,
    description: 'Progress, 0-100. Set automatically to 100 when status becomes COMPLETED.',
  },
  priority: {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 9,
    description:
      'RFC 5545 priority: 1 is highest, 9 is lowest, 0 or null means none. ' +
      'The Tasks UI shows 1-4 as high, 5 as medium, 6-9 as low.',
  },
  due: {
    type: ['string', 'null'],
    description:
      'Due date: "YYYY-MM-DD" for a whole day, "YYYY-MM-DDTHH:MM:SS" for a local time, ' +
      'or "...Z" for UTC. null removes it.',
  },
  dueTimezone: {
    type: 'string',
    description:
      'IANA zone for a local due time, e.g. "Europe/London". Stored as the equivalent ' +
      'UTC instant. Not valid with a whole-day date or a "Z" time.',
  },
  start: {
    type: ['string', 'null'],
    description: 'Start date, same format as due. null removes it.',
  },
  startTimezone: { type: 'string', description: 'IANA zone for a local start time.' },
  location: { type: ['string', 'null'], description: 'Free-text location. null removes it.' },
  categories: {
    type: ['array', 'null'],
    items: { type: 'string' },
    description: 'Tags, replacing any already set. null or [] removes them all.',
  },
  parentUid: {
    type: ['string', 'null'],
    description:
      'uid of the parent task, making this a subtask of it. Must be in the same list. ' +
      'null detaches it to the top level.',
  },
  pinned: { type: ['boolean', 'null'], description: "Nextcloud's pinned flag." },
  hideSubtasks: {
    type: ['boolean', 'null'],
    description: "Collapse this task's subtasks in the Tasks UI.",
  },
  sortOrder: {
    type: ['integer', 'null'],
    description: 'Manual sort position within the list.',
  },
} as const;

const EditArgs = {
  summary: z.string().optional(),
  description: Clearable(z.string()).optional(),
  status: StatusEnum.optional(),
  percentComplete: Clearable(Int.refine((n) => n >= 0 && n <= 100, 'must be between 0 and 100')).optional(),
  priority: Clearable(Int.refine((n) => n >= 0 && n <= 9, 'must be between 0 and 9')).optional(),
  due: Clearable(z.string()).optional(),
  dueTimezone: z.string().optional(),
  start: Clearable(z.string()).optional(),
  startTimezone: z.string().optional(),
  location: Clearable(z.string()).optional(),
  categories: Clearable(z.array(z.string())).optional(),
  parentUid: Clearable(Uid).optional(),
  pinned: Clearable(Bool).optional(),
  hideSubtasks: Clearable(Bool).optional(),
  sortOrder: Clearable(Int).optional(),
};

// -----------------------------------------------------------------------------
// ping
// -----------------------------------------------------------------------------

const pingTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'ping',
    description:
      'Verify connectivity and credentials against Nextcloud CalDAV. Returns the configured ' +
      'server and user, the discovered calendar home, and the task lists found there.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Check connection',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => {
    const calendarHome = await ctx.api.calendarHome();
    const lists = await ctx.api.taskLists();
    return jsonResult({
      ok: true,
      target: ctx.configSummary,
      calendarHome,
      taskLists: lists.map((l) => ({
        uri: l.uri,
        displayName: l.displayName,
        readOnly: l.readOnly,
      })),
    });
  },
};

// -----------------------------------------------------------------------------
// Task lists
// -----------------------------------------------------------------------------

const listTaskListsTool: ToolDef<typeof Empty> = {
  argsSchema: Empty,
  tool: {
    name: 'list_task_lists',
    description:
      'List the task lists in this account. Use the returned "uri" wherever a tool takes a ' +
      'list — it is stable, whereas the display name changes on rename and need not be unique.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'List task lists',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (_args, ctx) => jsonResult(await ctx.api.taskLists()),
};

// -----------------------------------------------------------------------------
// Reading tasks
// -----------------------------------------------------------------------------

const ListTasksArgs = z
  .object({
    list: z.string().optional(),
    includeCompleted: Bool.optional(),
    status: z.array(StatusEnum).optional(),
    dueBefore: z.string().optional(),
    dueAfter: z.string().optional(),
    includeUndated: Bool.optional(),
    tags: z.array(z.string()).optional(),
    parentUid: z.string().optional(),
    search: z.string().optional(),
    limit: Int.refine((n) => n > 0, 'must be positive').optional(),
    nest: Bool.optional(),
  })
  .strict();

const listTasksTool: ToolDef<typeof ListTasksArgs> = {
  argsSchema: ListTasksArgs,
  tool: {
    name: 'list_tasks',
    description:
      'List tasks, earliest deadline first. Searches every task list unless one is named. ' +
      'Completed and cancelled tasks are excluded unless includeCompleted is true. ' +
      'Results are sorted by due date, then priority, then title.',
    inputSchema: {
      type: 'object',
      properties: {
        list: {
          type: 'string',
          description: 'Task list uri or display name. Omit to search every list.',
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include COMPLETED and CANCELLED tasks. Default false.',
        },
        status: {
          type: 'array',
          items: { type: 'string', enum: [...TASK_STATUSES] },
          description: 'Keep only these statuses. Applied after includeCompleted.',
        },
        dueBefore: {
          type: 'string',
          description:
            'Keep tasks due strictly before this instant. A bare "YYYY-MM-DD" means midnight ' +
            'that day, so tasks due today are dueAfter today and dueBefore tomorrow.',
        },
        dueAfter: {
          type: 'string',
          description: 'Keep tasks due at or after this instant.',
        },
        includeUndated: {
          type: 'boolean',
          description:
            'Keep tasks with no due date when a due bound is set. Default false — a due-date ' +
            'filter otherwise silently drops everything undated.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keep tasks carrying every one of these tags (case-insensitive).',
        },
        parentUid: {
          type: 'string',
          description: 'Keep only subtasks of this uid, or "none" for top-level tasks only.',
        },
        search: {
          type: 'string',
          description: 'Case-insensitive substring match over title, description and location.',
        },
        limit: { type: 'integer', minimum: 1, description: 'Maximum tasks to return.' },
        nest: {
          type: 'boolean',
          description:
            'Return a tree, each task carrying its subtasks, instead of a flat list. ' +
            'A subtask whose parent is not in the result stays at the top level.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'List tasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { lists, tasks } = await ctx.api.listTasks({
      ...(args.list !== undefined ? { list: args.list } : {}),
      ...(args.includeCompleted !== undefined ? { includeCompleted: args.includeCompleted } : {}),
      ...(args.status !== undefined ? { status: args.status as Task['status'][] } : {}),
      ...(args.dueBefore !== undefined ? { dueBefore: args.dueBefore } : {}),
      ...(args.dueAfter !== undefined ? { dueAfter: args.dueAfter } : {}),
      ...(args.includeUndated !== undefined ? { includeUndated: args.includeUndated } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.parentUid !== undefined ? { parentUid: args.parentUid } : {}),
      ...(args.search !== undefined ? { search: args.search } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });

    return jsonResult(
      {
        searched: lists.map((l) => l.uri),
        count: tasks.length,
        tasks: args.nest
          ? buildTree(tasks).map(nestCompact)
          : tasks.map(compact),
      },
      'Narrow it with list, limit, a due-date window, or search.',
    );
  },
};

/** Compact a tree node and its children, dropping an empty subtasks array. */
function nestCompact(node: { subtasks: unknown[] } & Task): Record<string, unknown> {
  const { subtasks, ...task } = node;
  const out = compact(task as Task);
  if (subtasks.length > 0) {
    out.subtasks = (subtasks as (Task & { subtasks: unknown[] })[]).map(nestCompact);
  }
  return out;
}

const GetTaskArgs = z.object({ uid: Uid, list: z.string().optional() }).strict();

const getTaskTool: ToolDef<typeof GetTaskArgs> = {
  argsSchema: GetTaskArgs,
  tool: {
    name: 'get_task',
    description:
      'Read one task by uid, including its etag. Naming the list makes this one request ' +
      'instead of one per list.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The task uid, as returned by list_tasks.' },
        list: { type: 'string', description: 'Task list uri or display name.' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Get task',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { task, list } = await ctx.api.findTask(args.uid, args.list);
    return jsonResult({ ...compact(task), listDisplayName: list.displayName });
  },
};

// -----------------------------------------------------------------------------
// Writing tasks
// -----------------------------------------------------------------------------

const CreateTaskArgs = z
  .object({
    ...EditArgs,
    // A task with no title is indistinguishable from the others in every UI
    // that shows it, so it is required here even though iCalendar allows it.
    summary: z.string().trim().min(1, 'summary must not be empty'),
    list: z.string().optional(),
  })
  .strict()
  .superRefine(checkTimezonePairs);

const createTaskTool: ToolDef<typeof CreateTaskArgs> = {
  argsSchema: CreateTaskArgs,
  tool: {
    name: 'create_task',
    description:
      'Create a task. The list may be omitted when the account has one task list or ' +
      'NEXTCLOUD_DEFAULT_TASK_LIST is set. Returns the task as stored, including its new uid.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Task list uri or display name.' },
        ...EDIT_PROPERTIES,
      },
      required: ['summary'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const task = await ctx.api.createTask(args.list, toEdits(args));
    return jsonResult(compact(task));
  },
};

/**
 * Reject a timezone given without the date it qualifies.
 *
 * `dueTimezone` is only ever read alongside `due`, so on its own it changes
 * nothing — but it satisfies the "at least one field" check, so the call
 * succeeds, rewrites `DTSTAMP` and `LAST-MODIFIED`, and can lose a concurrent
 * edit to a conflict while silently ignoring the only thing that was asked for.
 * A no-op that reports success is worse than an error.
 */
function checkTimezonePairs(
  args: { due?: unknown; dueTimezone?: unknown; start?: unknown; startTimezone?: unknown },
  ctx: z.RefinementCtx,
): void {
  for (const [zone, date] of [
    ['dueTimezone', 'due'],
    ['startTimezone', 'start'],
  ] as const) {
    if (args[zone] === undefined) continue;
    if (args[date] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [zone],
        message: `${zone} only applies to a ${date} date, so pass ${date} as well.`,
      });
    } else if (args[date] === null) {
      ctx.addIssue({
        code: 'custom',
        path: [zone],
        message: `${zone} cannot be used while clearing ${date}.`,
      });
    }
  }
}

const UpdateTaskArgs = z
  .object({
    uid: Uid,
    list: z.string().optional(),
    etag: z.string().optional(),
    ...EditArgs,
  })
  .strict()
  .refine(
    (a) => Object.keys(EditArgs).some((k) => a[k as keyof typeof EditArgs] !== undefined),
    { message: `Supply at least one field to change: ${Object.keys(EditArgs).join(', ')}.` },
  )
  .superRefine(checkTimezonePairs);

const updateTaskTool: ToolDef<typeof UpdateTaskArgs> = {
  argsSchema: UpdateTaskArgs,
  tool: {
    name: 'update_task',
    description:
      'Change fields on an existing task. Only the fields given are touched; everything else ' +
      'on the task — including recurrence, reminders and properties written by other CalDAV ' +
      'clients — is preserved. Pass null to clear a field. Pass an etag to make the write ' +
      'conditional on nobody else having changed the task first.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The task uid.' },
        list: { type: 'string', description: 'Task list uri or display name.' },
        etag: {
          type: 'string',
          description:
            'Etag from get_task. The write is refused if the task changed since. ' +
            'Omit to overwrite unconditionally.',
        },
        ...EDIT_PROPERTIES,
      },
      required: ['uid'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Update task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const task = await ctx.api.updateTask(args.uid, args.list, toEdits(args), args.etag);
    return jsonResult(compact(task));
  },
};

const CompletionArgs = z
  .object({ uid: Uid, list: z.string().optional(), etag: z.string().optional() })
  .strict();

const COMPLETION_SCHEMA = {
  type: 'object' as const,
  properties: {
    uid: { type: 'string', description: 'The task uid.' },
    list: { type: 'string', description: 'Task list uri or display name.' },
    etag: { type: 'string', description: 'Etag from get_task, to make the write conditional.' },
  },
  required: ['uid'],
  additionalProperties: false,
};

const completeTaskTool: ToolDef<typeof CompletionArgs> = {
  argsSchema: CompletionArgs,
  tool: {
    name: 'complete_task',
    description:
      'Mark a task done: status COMPLETED, 100 percent, completed timestamp now. ' +
      'Repeating tasks are refused — completing one has to advance it to its next ' +
      'occurrence, and closing it here would end the series.',
    inputSchema: COMPLETION_SCHEMA,
    annotations: {
      title: 'Complete task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const task = await ctx.api.setCompletion(args.uid, args.list, true, args.etag);
    return jsonResult(compact(task));
  },
};

const uncompleteTaskTool: ToolDef<typeof CompletionArgs> = {
  argsSchema: CompletionArgs,
  tool: {
    name: 'uncomplete_task',
    description:
      'Reopen a completed task: status NEEDS-ACTION, completion timestamp removed.',
    inputSchema: COMPLETION_SCHEMA,
    annotations: {
      title: 'Reopen task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const task = await ctx.api.setCompletion(args.uid, args.list, false, args.etag);
    return jsonResult(compact(task));
  },
};

const DeleteTaskArgs = z
  .object({ uid: Uid, list: z.string().optional(), etag: z.string().optional() })
  .strict();

const deleteTaskTool: ToolDef<typeof DeleteTaskArgs> = {
  argsSchema: DeleteTaskArgs,
  tool: {
    name: 'delete_task',
    description:
      'Delete a task permanently. Subtasks are not deleted — they are left in place and ' +
      'reported as orphaned, so nothing is destroyed that was not named.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The task uid.' },
        list: { type: 'string', description: 'Task list uri or display name.' },
        etag: { type: 'string', description: 'Etag from get_task, to make the delete conditional.' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const { deleted, orphanedSubtasks } = await ctx.api.deleteTask(args.uid, args.list, args.etag);
    return jsonResult({
      deleted: { uid: deleted.uid, summary: deleted.summary, list: deleted.list },
      ...(orphanedSubtasks.length > 0 ? { orphanedSubtasks } : {}),
    });
  },
};

const MoveTaskArgs = z
  .object({ uid: Uid, toList: z.string().trim().min(1), list: z.string().optional() })
  .strict();

const moveTaskTool: ToolDef<typeof MoveTaskArgs> = {
  argsSchema: MoveTaskArgs,
  tool: {
    name: 'move_task',
    description:
      'Move a task to another task list, keeping its uid and every property. Subtasks are ' +
      'not moved with it, and a parent link only resolves within one list, so move a parent ' +
      'and its subtasks together if you want the hierarchy to survive.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The task uid.' },
        toList: { type: 'string', description: 'Destination task list uri or display name.' },
        list: { type: 'string', description: 'Source task list, if known.' },
      },
      required: ['uid', 'toList'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Move task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => {
    const task = await ctx.api.moveTask(args.uid, args.list, args.toList);
    return jsonResult(compact(task));
  },
};

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

const ListTagsArgs = z.object({ list: z.string().optional() }).strict();

const listTagsTool: ToolDef<typeof ListTagsArgs> = {
  argsSchema: ListTagsArgs,
  tool: {
    name: 'list_tags',
    description:
      'List the tags in use with a count of the tasks carrying each, completed ones included. ' +
      'Useful for finding the exact spelling of a tag before filtering list_tasks by it.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Restrict to one task list. Omit for all lists.' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'List tags',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args, ctx) => jsonResult(await ctx.api.listTags(args.list)),
};

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const REGISTRY = {
  ping: pingTool,
  list_task_lists: listTaskListsTool,
  list_tasks: listTasksTool,
  get_task: getTaskTool,
  create_task: createTaskTool,
  update_task: updateTaskTool,
  complete_task: completeTaskTool,
  uncomplete_task: uncompleteTaskTool,
  delete_task: deleteTaskTool,
  move_task: moveTaskTool,
  list_tags: listTagsTool,
} as const;

export const TOOLS: Tool[] = Object.values(REGISTRY).map((d) => d.tool);

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: Context,
): Promise<CallToolResult> {
  const def = (REGISTRY as unknown as Record<string, ToolDef<ZodTypeAny>>)[name];
  if (!def) {
    return errorResult(`Unknown tool: ${name}`);
  }

  const parseResult = def.argsSchema.safeParse(rawArgs ?? {});
  if (!parseResult.success) {
    return errorResult(
      `Invalid arguments for ${name}: ${parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  try {
    return await def.handler(parseResult.data, ctx);
  } catch (err) {
    if (
      err instanceof ConflictError ||
      err instanceof NotFoundError ||
      err instanceof AmbiguousError ||
      err instanceof UnsupportedError ||
      err instanceof IcalError ||
      err instanceof RedirectRefusedError ||
      err instanceof HttpError
    ) {
      return errorResult(err.message);
    }
    if (err instanceof XmlParseError) {
      return errorResult(
        `${err.message}\n\nThe server's DAV response could not be parsed. This usually means a ` +
          'proxy returned an HTML error page in place of the CalDAV response.',
      );
    }
    if (err instanceof Error) {
      return errorResult(err.message);
    }
    return errorResult(String(err));
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
