import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { buildTree, dateBoundKey, dateSortKey, TasksApi } from './api.js';
import {
  buildCalendarQuery,
  buildMultiget,
  hrefToUri,
  normalizeHref,
  parseCalendarObjects,
  parseMultistatus,
  propKey,
} from './caldav.js';
import { canonicalizeBaseUrl, DEFAULT_TIMEOUT_MS, loadConfig, MAX_TIMEOUT_MS } from './config.js';
import { encodeSegment, NextcloudClient, normalizeEtag } from './http.js';
import {
  applyEdits,
  buildTaskIcs,
  findMasterVtodo,
  IcalError,
  parseCalendar,
  parseDateInput,
  serializeCalendar,
  taskFromIcs,
} from './ical.js';
import { dispatchTool, TOOLS } from './tools.js';
import type { Task } from './types.js';
import { decodeEntities, escapeXml, find, findText, NS, parseXml, XmlParseError } from './xml.js';

// -----------------------------------------------------------------------------
// xml.ts
// -----------------------------------------------------------------------------

describe('parseXml', () => {
  it('resolves namespaces by URI, not by prefix', () => {
    const a = parseXml('<d:multistatus xmlns:d="DAV:"><d:href>/x</d:href></d:multistatus>');
    const b = parseXml('<D:multistatus xmlns:D="DAV:"><D:href>/x</D:href></D:multistatus>');
    const c = parseXml('<multistatus xmlns="DAV:"><href>/x</href></multistatus>');
    for (const root of [a, b, c]) {
      assert.equal(root.ns, NS.dav);
      assert.equal(root.name, 'multistatus');
      assert.equal(findText(root, NS.dav, 'href'), '/x');
    }
  });

  it('keeps sibling namespaces distinct', () => {
    const root = parseXml(
      '<d:prop xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<d:getetag>"1"</d:getetag><c:calendar-data>BEGIN</c:calendar-data></d:prop>',
    );
    assert.equal(findText(root, NS.dav, 'getetag'), '"1"');
    assert.equal(findText(root, NS.caldav, 'calendar-data'), 'BEGIN');
    assert.equal(find(root, NS.dav, 'calendar-data'), undefined);
  });

  it('applies a child namespace declaration only within that child', () => {
    const root = parseXml(
      '<r xmlns="urn:outer"><a xmlns="urn:inner"><b/></a><c/></r>',
    );
    assert.equal(root.ns, 'urn:outer');
    const a = find(root, 'urn:inner', 'a');
    assert.ok(a);
    assert.equal(a.children[0]?.ns, 'urn:inner');
    assert.ok(find(root, 'urn:outer', 'c'));
  });

  it('handles self-closing elements and their attributes', () => {
    const root = parseXml(
      '<c:set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<c:comp name="VEVENT"/><c:comp name="VTODO" /></c:set>',
    );
    const comps = root.children;
    assert.equal(comps.length, 2);
    assert.equal(comps[0]?.attrs.name, 'VEVENT');
    assert.equal(comps[1]?.attrs.name, 'VTODO');
  });

  it('does not end a tag on a > inside an attribute value', () => {
    const root = parseXml('<a title="1 &gt; 0 and a > b"><b/></a>');
    assert.equal(root.attrs.title, '1 > 0 and a > b');
    assert.equal(root.children.length, 1);
  });

  it('decodes entities in text and attributes but not in CDATA', () => {
    const root = parseXml(
      '<r><a>a &amp; b &lt;c&gt; &#65; &#x42;</a><b><![CDATA[raw &amp; <tag>]]></b></r>',
    );
    assert.equal(findText(root, '', 'a'), 'a & b <c> A B');
    assert.equal(findText(root, '', 'b'), 'raw &amp; <tag>');
  });

  it('leaves an unknown entity verbatim rather than dropping it', () => {
    assert.equal(decodeEntities('50% &discount; done'), '50% &discount; done');
    assert.equal(decodeEntities('a &amp; b'), 'a & b');
  });

  it('skips comments, processing instructions and DOCTYPEs', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><r><!-- note --><a>1</a></r>',
    );
    assert.equal(findText(root, '', 'a'), '1');
  });

  it('does not expand DTD entities', () => {
    // The declaration is skipped wholesale, so &x; is never substituted.
    const root = parseXml('<!DOCTYPE r [<!ENTITY x "BOOM">]><r>&x;</r>');
    assert.equal(root.text, '&x;');
  });

  it('rejects malformed documents instead of returning a partial tree', () => {
    assert.throws(() => parseXml('<a><b></a>'), XmlParseError);
    assert.throws(() => parseXml('<a>'), XmlParseError);
    assert.throws(() => parseXml('not xml at all'), XmlParseError);
    assert.throws(() => parseXml('<a x=unquoted/>'), XmlParseError);
    assert.throws(() => parseXml('<a/><b/>'), XmlParseError);
  });

  it('round-trips through escapeXml', () => {
    const raw = `a & b < c > d " e ' f`;
    const root = parseXml(`<r>${escapeXml(raw)}</r>`);
    assert.equal(root.text, raw);
  });
});

// -----------------------------------------------------------------------------
// caldav.ts — multistatus
// -----------------------------------------------------------------------------

const MULTISTATUS_MIXED = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/personal/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Personal</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:getctag/><c:calendar-data/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe('parseMultistatus', () => {
  it('reads properties only from 2xx propstat blocks', () => {
    const [resource] = parseMultistatus(MULTISTATUS_MIXED);
    assert.ok(resource);
    assert.equal(resource.props.get(propKey(NS.dav, 'displayname'))?.text, 'Personal');
    // Present in the document, but under a 404 — must not be treated as returned.
    assert.equal(resource.props.has(propKey(NS.caldav, 'calendar-data')), false);
  });

  it('rejects a document that is not a multistatus', () => {
    assert.throws(
      () => parseMultistatus('<d:error xmlns:d="DAV:"><d:message>no</d:message></d:error>'),
      /multistatus/,
    );
  });

  it('normalises absolute hrefs to paths', () => {
    assert.equal(normalizeHref('https://cloud.example.com/remote.php/dav/x/'), '/remote.php/dav/x/');
    assert.equal(normalizeHref('/remote.php/dav/x/'), '/remote.php/dav/x/');
    assert.equal(normalizeHref('remote.php/dav/x/'), '/remote.php/dav/x/');
  });

  it('derives a list uri from the last path segment, decoded', () => {
    assert.equal(hrefToUri('/remote.php/dav/calendars/alice/personal/'), 'personal');
    assert.equal(hrefToUri('/remote.php/dav/calendars/alice/work%20stuff/'), 'work stuff');
  });
});

describe('parseCalendarObjects', () => {
  it('unescapes iCalendar carried inside calendar-data', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/alice/personal/a.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"abc"</d:getetag>
        <c:calendar-data>BEGIN:VTODO&#13;
SUMMARY:Ship &amp; invoice &lt;urgent&gt;&#13;
END:VTODO</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
    const [object] = parseCalendarObjects(xml);
    assert.ok(object);
    assert.equal(object.etag, '"abc"');
    assert.match(object.ics!, /SUMMARY:Ship & invoice <urgent>/);
  });

  it('skips responses the server reported as failed', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/cal/alice/personal/gone.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
</d:multistatus>`;
    assert.deepEqual(parseCalendarObjects(xml), []);
  });
});

describe('report bodies', () => {
  it('filters completed tasks server-side only when asked', () => {
    assert.match(buildCalendarQuery({ excludeCompleted: true }), /COMPLETED[\s\S]*is-not-defined/);
    assert.doesNotMatch(buildCalendarQuery(), /is-not-defined/);
  });

  it('matches a uid exactly, with an octet collation', () => {
    const body = buildCalendarQuery({ uid: 'abc-123' });
    assert.match(body, /collation="i;octet"/);
    assert.match(body, />abc-123</);
  });

  it('escapes a uid that would otherwise break the request document', () => {
    const body = buildCalendarQuery({ uid: '</c:text-match><evil/>' });
    assert.doesNotMatch(body, /<evil\/>/);
    assert.match(body, /&lt;\/c:text-match&gt;/);
    assert.doesNotThrow(() => parseXml(body.replace(/^<\?xml[^>]*\?>/, '')));
  });

  it('escapes hrefs in a multiget', () => {
    const body = buildMultiget(['/cal/a%20b.ics', '/cal/x&y.ics']);
    assert.match(body, /\/cal\/a%20b\.ics/);
    assert.match(body, /x&amp;y/);
  });
});

// -----------------------------------------------------------------------------
// ical.ts — dates
// -----------------------------------------------------------------------------

describe('parseDateInput', () => {
  it('keeps a whole day as a DATE value', () => {
    const time = parseDateInput('2026-03-01');
    assert.equal(time.isDate, true);
    assert.equal(time.toICALString(), '20260301');
  });

  it('keeps an explicit UTC time in UTC', () => {
    assert.equal(parseDateInput('2026-03-01T14:30:00Z').toICALString(), '20260301T143000Z');
    assert.equal(parseDateInput('2026-03-01T14:30Z').toICALString(), '20260301T143000Z');
  });

  it('resolves a zoned wall-clock time to the right UTC instant across DST', () => {
    // London is UTC+0 in January and UTC+1 in July.
    assert.equal(
      parseDateInput('2026-01-15T12:00:00', 'Europe/London').toICALString(),
      '20260115T120000Z',
    );
    assert.equal(
      parseDateInput('2026-07-15T12:00:00', 'Europe/London').toICALString(),
      '20260715T110000Z',
    );
    // A zone on the other side of UTC, to catch a sign error.
    assert.equal(
      parseDateInput('2026-07-15T12:00:00', 'America/New_York').toICALString(),
      '20260715T160000Z',
    );
  });

  it('keeps a time with neither Z nor zone floating', () => {
    const time = parseDateInput('2026-03-01T09:00:00');
    assert.equal(time.toICALString(), '20260301T090000');
    assert.equal(time.isDate, false);
  });

  it('rejects combinations that would silently mean something else', () => {
    assert.throws(() => parseDateInput('2026-03-01', 'Europe/London'), IcalError);
    assert.throws(() => parseDateInput('2026-03-01T09:00:00Z', 'Europe/London'), IcalError);
    assert.throws(() => parseDateInput('2026-03-01T09:00:00', 'Mars/Olympus'), IcalError);
    assert.throws(() => parseDateInput('next tuesday'), IcalError);
    assert.throws(() => parseDateInput('01/03/2026'), IcalError);
  });
});

// -----------------------------------------------------------------------------
// ical.ts — reading
// -----------------------------------------------------------------------------

const FULL_VTODO = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Other Client//EN
BEGIN:VTODO
UID:task-1
DTSTAMP:20260101T120000Z
CREATED:20260101T120000Z
LAST-MODIFIED:20260102T090000Z
SUMMARY:Ship the thing
DESCRIPTION:Two lines\\nsecond line\\, with a comma
STATUS:IN-PROCESS
PRIORITY:1
PERCENT-COMPLETE:40
DUE;TZID=Europe/London:20260110T170000
DTSTART;VALUE=DATE:20260105
LOCATION:The office
CATEGORIES:work,urgent
CATEGORIES:q1
RELATED-TO;RELTYPE=SIBLING:other-task
RELATED-TO:parent-task
X-PINNED:true
X-OC-HIDESUBTASKS:1
X-APPLE-SORT-ORDER:7
X-CUSTOM-FROM-ANOTHER-CLIENT:keep me
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Reminder
END:VALARM
END:VTODO
END:VCALENDAR`;

describe('taskFromIcs', () => {
  const task = taskFromIcs(FULL_VTODO, { href: '/cal/a.ics', etag: '"e1"', list: 'personal' })!;

  it('maps the standard properties', () => {
    assert.equal(task.uid, 'task-1');
    assert.equal(task.summary, 'Ship the thing');
    assert.equal(task.description, 'Two lines\nsecond line, with a comma');
    assert.equal(task.status, 'IN-PROCESS');
    assert.equal(task.priority, 1);
    assert.equal(task.percentComplete, 40);
    assert.equal(task.location, 'The office');
    assert.equal(task.etag, '"e1"');
    assert.equal(task.list, 'personal');
  });

  it('reads the TZID from the parameter, not from the resolved zone', () => {
    assert.deepEqual(task.due, {
      value: '2026-01-10T17:00:00',
      isDate: false,
      timezone: 'Europe/London',
    });
  });

  it('keeps a whole-day start as a date', () => {
    assert.deepEqual(task.start, { value: '2026-01-05', isDate: true });
  });

  it('collects every value across every CATEGORIES property', () => {
    assert.deepEqual(task.categories, ['work', 'urgent', 'q1']);
  });

  it('treats a bare RELATED-TO as a parent and ignores SIBLING', () => {
    assert.equal(task.parentUid, 'parent-task');
  });

  it('reads the Nextcloud X-properties in both spellings', () => {
    assert.equal(task.pinned, true);
    assert.equal(task.hideSubtasks, true);
    assert.equal(task.sortOrder, 7);
  });

  it('reports alarms without exposing them as editable', () => {
    assert.equal(task.alarmCount, 1);
    assert.equal(task.recurrenceRule, undefined);
  });

  it('reports a recurrence rule when there is one', () => {
    const ics = FULL_VTODO.replace('STATUS:IN-PROCESS', 'STATUS:IN-PROCESS\nRRULE:FREQ=WEEKLY;COUNT=5');
    const recurring = taskFromIcs(ics, { href: '/cal/a.ics', list: 'personal' })!;
    assert.match(recurring.recurrenceRule!, /FREQ=WEEKLY/);
  });

  it('returns null for a calendar object that holds no task', () => {
    const event = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:e1
DTSTAMP:20260101T120000Z
SUMMARY:A meeting
END:VEVENT
END:VCALENDAR`;
    assert.equal(taskFromIcs(event, { href: '/cal/e.ics', list: 'personal' }), null);
  });

  it('defaults a missing status to NEEDS-ACTION', () => {
    const ics = FULL_VTODO.replace('STATUS:IN-PROCESS\n', '');
    assert.equal(taskFromIcs(ics, { href: '/x', list: 'p' })!.status, 'NEEDS-ACTION');
  });

  it('refuses a task with no UID, which could not be addressed again', () => {
    const ics = FULL_VTODO.replace('UID:task-1\n', '');
    assert.throws(() => taskFromIcs(ics, { href: '/x', list: 'p' }), IcalError);
  });

  it('picks the master of a recurring series, not an override', () => {
    const series = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:s1
RECURRENCE-ID:20260201T090000Z
SUMMARY:Override
END:VTODO
BEGIN:VTODO
UID:s1
RRULE:FREQ=MONTHLY
SUMMARY:Master
END:VTODO
END:VCALENDAR`;
    assert.equal(taskFromIcs(series, { href: '/x', list: 'p' })!.summary, 'Master');
  });
});

// -----------------------------------------------------------------------------
// ical.ts — writing
// -----------------------------------------------------------------------------

function editFullVtodo(edits: Parameters<typeof applyEdits>[1]): string {
  const calendar = parseCalendar(FULL_VTODO);
  applyEdits(findMasterVtodo(calendar)!, edits);
  return serializeCalendar(calendar);
}

describe('applyEdits', () => {
  it('preserves properties it does not model', () => {
    const out = editFullVtodo({ summary: 'Renamed' });
    assert.match(out, /SUMMARY:Renamed/);
    assert.match(out, /X-CUSTOM-FROM-ANOTHER-CLIENT:keep me/);
    assert.match(out, /BEGIN:VALARM/);
    assert.match(out, /RELATED-TO;RELTYPE=SIBLING:other-task/);
  });

  it('distinguishes leaving a field alone from clearing it', () => {
    // Read back rather than grepped: the VALARM has a DESCRIPTION of its own,
    // and a regex over the whole object cannot tell the two apart.
    const untouched = taskFromIcs(editFullVtodo({ summary: 'x' }), { href: '/x', list: 'p' })!;
    assert.equal(untouched.description, 'Two lines\nsecond line, with a comma');
    const cleared = taskFromIcs(editFullVtodo({ description: null }), { href: '/x', list: 'p' })!;
    assert.equal(cleared.description, undefined);
    // Clearing the task's own description must not touch the alarm's.
    assert.match(editFullVtodo({ description: null }), /DESCRIPTION:Reminder/);
  });

  it('clears the due date without disturbing the start date', () => {
    const out = editFullVtodo({ due: null });
    assert.doesNotMatch(out, /^DUE/m);
    assert.match(out, /DTSTART;VALUE=DATE:20260105/);
  });

  it('drops a stale TZID when the due date is replaced with a whole day', () => {
    const out = editFullVtodo({ due: '2026-04-01' });
    assert.match(out, /DUE;VALUE=DATE:20260401/);
    assert.doesNotMatch(out, /DUE;TZID/);
  });

  it('completing a task sets the timestamp and percentage', () => {
    const out = editFullVtodo({ status: 'COMPLETED' });
    assert.match(out, /STATUS:COMPLETED/);
    assert.match(out, /^COMPLETED:\d{8}T\d{6}Z/m);
    assert.match(out, /PERCENT-COMPLETE:100/);
  });

  it('reopening a task removes the completion timestamp', () => {
    const completed = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:c1
STATUS:COMPLETED
COMPLETED:20260101T120000Z
PERCENT-COMPLETE:100
END:VTODO
END:VCALENDAR`;
    const calendar = parseCalendar(completed);
    applyEdits(findMasterVtodo(calendar)!, { status: 'NEEDS-ACTION' });
    const out = serializeCalendar(calendar);
    assert.match(out, /STATUS:NEEDS-ACTION/);
    assert.doesNotMatch(out, /^COMPLETED:/m);
    assert.doesNotMatch(out, /PERCENT-COMPLETE:100/);
  });

  it('writes priority 0 as an absent property', () => {
    assert.doesNotMatch(editFullVtodo({ priority: 0 }), /^PRIORITY:/m);
    assert.doesNotMatch(editFullVtodo({ priority: null }), /^PRIORITY:/m);
    assert.match(editFullVtodo({ priority: 9 }), /PRIORITY:9/);
  });

  it('replaces the whole tag set and can empty it', () => {
    const out = editFullVtodo({ categories: ['home', 'weekend'] });
    assert.match(out, /CATEGORIES:home,weekend/);
    assert.doesNotMatch(out, /CATEGORIES:work/);
    assert.doesNotMatch(editFullVtodo({ categories: [] }), /^CATEGORIES:/m);
    assert.doesNotMatch(editFullVtodo({ categories: null }), /^CATEGORIES:/m);
  });

  it('rewrites only the parent relation, leaving other relations alone', () => {
    const out = editFullVtodo({ parentUid: 'new-parent' });
    assert.match(out, /RELATED-TO;RELTYPE=PARENT:new-parent/);
    assert.doesNotMatch(out, /parent-task/);
    assert.match(out, /RELATED-TO;RELTYPE=SIBLING:other-task/);
  });

  it('detaches a subtask when the parent is cleared', () => {
    const out = editFullVtodo({ parentUid: null });
    assert.doesNotMatch(out, /parent-task/);
    assert.match(out, /RELATED-TO;RELTYPE=SIBLING:other-task/);
  });

  it('stamps the modification time on every write', () => {
    const before = parseCalendar(FULL_VTODO);
    assert.match(serializeCalendar(before), /LAST-MODIFIED:20260102T090000Z/);
    assert.doesNotMatch(editFullVtodo({ summary: 'x' }), /LAST-MODIFIED:20260102T090000Z/);
  });

  it('escapes text that would otherwise break the iCalendar grammar', () => {
    const out = editFullVtodo({ description: 'a, b; c\nd\\e' });
    const reread = taskFromIcs(out, { href: '/x', list: 'p' })!;
    assert.equal(reread.description, 'a, b; c\nd\\e');
  });
});

describe('buildTaskIcs', () => {
  it('produces a parseable task with the fields given', () => {
    const ics = buildTaskIcs('new-1', {
      summary: 'Write tests',
      due: '2026-05-01',
      priority: 2,
      categories: ['dev'],
    });
    const task = taskFromIcs(ics, { href: '/x', list: 'p' })!;
    assert.equal(task.uid, 'new-1');
    assert.equal(task.summary, 'Write tests');
    assert.equal(task.status, 'NEEDS-ACTION');
    assert.deepEqual(task.due, { value: '2026-05-01', isDate: true });
    assert.equal(task.priority, 2);
    assert.deepEqual(task.categories, ['dev']);
  });

  it('honours an explicit status instead of defaulting', () => {
    const ics = buildTaskIcs('new-2', { summary: 'Already done', status: 'COMPLETED' });
    const task = taskFromIcs(ics, { href: '/x', list: 'p' })!;
    assert.equal(task.status, 'COMPLETED');
    assert.ok(task.completed);
  });

  it('emits CRLF line endings as RFC 5545 requires', () => {
    const calendar = parseCalendar(buildTaskIcs('new-3', { summary: 'x' }));
    assert.match(serializeCalendar(calendar), /\r\n/);
  });
});

// -----------------------------------------------------------------------------
// api.ts — filtering and shaping
// -----------------------------------------------------------------------------

function task(partial: Partial<Task> & { uid: string }): Task {
  return {
    href: `/cal/${partial.uid}.ics`,
    list: 'personal',
    status: 'NEEDS-ACTION',
    categories: [],
    recurring: false,
    alarmCount: 0,
    ...partial,
  };
}

describe('dateSortKey', () => {
  it('sorts a whole day at its own midnight', () => {
    assert.equal(
      dateSortKey({ value: '2026-03-01', isDate: true }),
      Date.parse('2026-03-01T00:00:00Z'),
    );
  });

  it('reads a floating time as UTC so ordering stays consistent', () => {
    assert.equal(
      dateSortKey({ value: '2026-03-01T09:00:00', isDate: false }),
      Date.parse('2026-03-01T09:00:00Z'),
    );
  });

  it('returns undefined for an absent or unusable date', () => {
    assert.equal(dateSortKey(undefined), undefined);
    assert.equal(dateSortKey({ value: 'nonsense', isDate: false }), undefined);
  });
});

describe('buildTree', () => {
  it('nests subtasks under their parents', () => {
    const roots = buildTree([
      task({ uid: 'a' }),
      task({ uid: 'b', parentUid: 'a' }),
      task({ uid: 'c', parentUid: 'b' }),
    ]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.uid, 'a');
    assert.equal(roots[0]?.subtasks[0]?.uid, 'b');
    assert.equal(roots[0]?.subtasks[0]?.subtasks[0]?.uid, 'c');
  });

  it('keeps an orphan at the top level rather than losing it', () => {
    const roots = buildTree([task({ uid: 'b', parentUid: 'missing' })]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.uid, 'b');
  });

  it('does not lose a task that claims itself as its parent', () => {
    const roots = buildTree([task({ uid: 'a', parentUid: 'a' })]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.subtasks.length, 0);
  });

  // #3: UIDs are per-list, so a global key collides across lists.
  it('keeps both tasks when the same uid exists in two lists', () => {
    const roots = buildTree([
      task({ uid: 'same', list: 'one', summary: 'one' }),
      task({ uid: 'same', list: 'two', summary: 'two' }),
    ]);
    assert.equal(roots.length, 2);
    assert.deepEqual(roots.map((r) => r.summary).sort(), ['one', 'two']);
  });

  it('does not resolve a parent link across lists', () => {
    const roots = buildTree([
      task({ uid: 'parent', list: 'one' }),
      task({ uid: 'child', list: 'two', parentUid: 'parent' }),
    ]);
    assert.equal(roots.length, 2);
    assert.equal(roots.find((r) => r.uid === 'parent')?.subtasks.length, 0);
  });

  it('nests within a list while another list has the same uids', () => {
    const roots = buildTree([
      task({ uid: 'p', list: 'one' }),
      task({ uid: 'c', list: 'one', parentUid: 'p' }),
      task({ uid: 'p', list: 'two' }),
      task({ uid: 'c', list: 'two', parentUid: 'p' }),
    ]);
    assert.equal(roots.length, 2);
    for (const root of roots) {
      assert.equal(root.subtasks.length, 1);
      assert.equal(root.subtasks[0]?.list, root.list);
    }
  });

  // #4: a cycle gives every node a parent, so none would become a root.
  it('keeps every task visible when the data contains a two-node cycle', () => {
    const roots = buildTree([
      task({ uid: 'a', parentUid: 'b' }),
      task({ uid: 'b', parentUid: 'a' }),
    ]);
    const seen = new Set<string>();
    const walk = (nodes: typeof roots): void => {
      for (const n of nodes) {
        assert.equal(seen.has(n.uid), false, `${n.uid} appeared twice`);
        seen.add(n.uid);
        walk(n.subtasks);
      }
    };
    walk(roots);
    assert.deepEqual([...seen].sort(), ['a', 'b']);
  });

  it('keeps every task visible in a longer cycle', () => {
    const roots = buildTree([
      task({ uid: 'a', parentUid: 'c' }),
      task({ uid: 'b', parentUid: 'a' }),
      task({ uid: 'c', parentUid: 'b' }),
    ]);
    const seen: string[] = [];
    const walk = (nodes: typeof roots): void => {
      for (const n of nodes) {
        seen.push(n.uid);
        walk(n.subtasks);
      }
    };
    walk(roots);
    assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  });

  it('serialises a cyclic input without recursing forever', () => {
    const roots = buildTree([
      task({ uid: 'a', parentUid: 'b' }),
      task({ uid: 'b', parentUid: 'a' }),
    ]);
    assert.doesNotThrow(() => JSON.stringify(roots));
  });

  it('returns every input task exactly once for a mixed input', () => {
    const input = [
      task({ uid: 'root' }),
      task({ uid: 'kid', parentUid: 'root' }),
      task({ uid: 'orphan', parentUid: 'gone' }),
      task({ uid: 'x', parentUid: 'y' }),
      task({ uid: 'y', parentUid: 'x' }),
      task({ uid: 'dup', list: 'other' }),
      task({ uid: 'dup' }),
    ];
    const roots = buildTree(input);
    let count = 0;
    const walk = (nodes: typeof roots): void => {
      for (const n of nodes) {
        count++;
        walk(n.subtasks);
      }
    };
    walk(roots);
    assert.equal(count, input.length);
  });
});

// -----------------------------------------------------------------------------
// http.ts helpers
// -----------------------------------------------------------------------------

describe('normalizeEtag', () => {
  it('strips the weak-validator prefix so If-Match compares strongly', () => {
    assert.equal(normalizeEtag('W/"abc"'), '"abc"');
    assert.equal(normalizeEtag('"abc"'), '"abc"');
    assert.equal(normalizeEtag(null), null);
    assert.equal(normalizeEtag('  '), null);
  });
});

describe('encodeSegment', () => {
  it('encodes the characters encodeURIComponent leaves behind', () => {
    assert.equal(encodeSegment("a'b(c)"), 'a%27b%28c%29');
    assert.equal(encodeSegment('a b/c'), 'a%20b%2Fc');
  });
});

// -----------------------------------------------------------------------------
// config.ts
// -----------------------------------------------------------------------------

describe('canonicalizeBaseUrl', () => {
  it('keeps a deployment sub-path and drops the trailing slash', () => {
    assert.equal(canonicalizeBaseUrl('https://example.com/nextcloud/'), 'https://example.com/nextcloud');
    assert.equal(canonicalizeBaseUrl('https://cloud.example.com'), 'https://cloud.example.com');
  });

  it('rejects a base URL that would swallow the endpoint path', () => {
    assert.throws(() => canonicalizeBaseUrl('https://example.com?x=1'), /query string/);
    assert.throws(() => canonicalizeBaseUrl('https://example.com#f'), /fragment/);
    assert.throws(() => canonicalizeBaseUrl('https://u:p@example.com'), /credentials/);
    assert.throws(() => canonicalizeBaseUrl('ftp://example.com'), /http or https/);
    assert.throws(() => canonicalizeBaseUrl('not-a-url'), /not a valid URL/);
  });
});

describe('loadConfig', () => {
  const base = {
    NEXTCLOUD_URL: 'https://cloud.example.com',
    NEXTCLOUD_USER: 'alice',
    NEXTCLOUD_APP_PASSWORD: 'secret',
  };

  it('names every missing variable at once', () => {
    assert.throws(() => loadConfig({}), /NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD/);
  });

  it('applies the defaults', () => {
    const config = loadConfig({ ...base });
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(config.defaultTaskList, undefined);
  });

  it('carries an optional default task list', () => {
    assert.equal(loadConfig({ ...base, NEXTCLOUD_DEFAULT_TASK_LIST: ' work ' }).defaultTaskList, 'work');
    assert.equal(loadConfig({ ...base, NEXTCLOUD_DEFAULT_TASK_LIST: '  ' }).defaultTaskList, undefined);
  });

  it('rejects a timeout that Node would silently clamp to 1ms', () => {
    assert.throws(
      () => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: String(MAX_TIMEOUT_MS + 1) }),
      /at most/,
    );
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '1.5' }), /whole number/);
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '-1' }), /positive/);
  });
});

// -----------------------------------------------------------------------------
// tools.ts
// -----------------------------------------------------------------------------

const ctx = {
  api: null as never,
  configSummary: 'https://cloud.example.com as alice',
};

async function callTool(name: string, args: unknown): Promise<string> {
  const result = await dispatchTool(name, args, ctx);
  const [content] = result.content as { type: string; text: string }[];
  return content?.text ?? '';
}

describe('tool definitions', () => {
  it('advertises every registered tool with a schema and annotations', () => {
    assert.ok(TOOLS.length >= 11);
    for (const tool of TOOLS) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must be strict`);
      assert.ok(tool.annotations?.title, `${tool.name} needs a title`);
    }
  });

  it('marks exactly the read-only tools as read-only', () => {
    const readOnly = TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, ['get_task', 'list_tags', 'list_task_lists', 'list_tasks', 'ping']);
  });

  it('marks delete_task as the destructive one', () => {
    const destructive = TOOLS.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    assert.deepEqual(destructive, ['delete_task']);
  });
});

describe('dispatchTool argument validation', () => {
  it('rejects an unknown tool', async () => {
    assert.match(await callTool('nope', {}), /Unknown tool/);
  });

  it('rejects unknown arguments rather than ignoring them', async () => {
    assert.match(await callTool('list_tasks', { lst: 'personal' }), /Invalid arguments/);
  });

  it('requires the arguments a tool cannot work without', async () => {
    assert.match(await callTool('get_task', {}), /Invalid arguments/);
    assert.match(await callTool('create_task', {}), /Invalid arguments/);
    assert.match(await callTool('move_task', { uid: 'a' }), /Invalid arguments/);
  });

  it('refuses an empty summary or uid', async () => {
    assert.match(await callTool('create_task', { summary: '   ' }), /summary must not be empty/);
    assert.match(await callTool('get_task', { uid: '' }), /uid must not be empty/);
  });

  it('does not read the string "false" as true', async () => {
    // Reaching the handler means validation passed; the null api then throws.
    const accepted = await callTool('list_tasks', { includeCompleted: 'false' });
    assert.doesNotMatch(accepted, /Invalid arguments/);
    assert.match(await callTool('list_tasks', { includeCompleted: 'yes' }), /Invalid arguments/);
    assert.match(await callTool('list_tasks', { includeCompleted: 1 }), /Invalid arguments/);
  });

  it('does not accept a non-decimal spelling of an integer', async () => {
    assert.match(await callTool('list_tasks', { limit: '0x10' }), /Invalid arguments/);
    assert.match(await callTool('list_tasks', { limit: true }), /Invalid arguments/);
    assert.match(await callTool('list_tasks', { limit: 0 }), /must be positive/);
  });

  it('bounds priority and percentComplete to their iCalendar ranges', async () => {
    assert.match(
      await callTool('create_task', { summary: 'x', priority: 10 }),
      /must be between 0 and 9/,
    );
    assert.match(
      await callTool('create_task', { summary: 'x', percentComplete: 101 }),
      /must be between 0 and 100/,
    );
  });

  it('requires at least one field to change on an update', async () => {
    assert.match(await callTool('update_task', { uid: 'a' }), /at least one field/);
  });

  it('accepts a known status and rejects an invented one', async () => {
    assert.doesNotMatch(
      await callTool('list_tasks', { status: ['NEEDS-ACTION'] }),
      /Invalid arguments/,
    );
    assert.match(await callTool('list_tasks', { status: ['DONE'] }), /Invalid arguments/);
  });
});

// -----------------------------------------------------------------------------
// Regression tests for the issues reported against d6f8c93
// -----------------------------------------------------------------------------

describe('parseXml rejects character data outside the root (#12)', () => {
  it('rejects leading and trailing text', () => {
    assert.throws(() => parseXml('garbage<r/>'), XmlParseError);
    assert.throws(() => parseXml('<r/>garbage'), XmlParseError);
    assert.throws(() => parseXml('  ok <r/>'), XmlParseError);
    assert.throws(() => parseXml('<r/> trailing words'), XmlParseError);
  });

  it('rejects an HTML error page concatenated onto a multistatus', () => {
    const doc = '<d:multistatus xmlns:d="DAV:"></d:multistatus>502 Bad Gateway';
    assert.throws(() => parseXml(doc), XmlParseError);
  });

  it('rejects a CDATA section at the top level', () => {
    assert.throws(() => parseXml('<![CDATA[hi]]><r/>'), XmlParseError);
  });

  it('still allows whitespace and a byte-order mark around the root', () => {
    assert.doesNotThrow(() => parseXml('\n  <r/>\n  '));
    assert.doesNotThrow(() => parseXml('﻿<?xml version="1.0"?>\n<r/>\n'));
  });
});

describe('parseDateInput rejects dates that do not exist (#5)', () => {
  it('refuses an out-of-range day or month instead of normalising it', () => {
    // Previously: "2026-02-30" silently became 2026-03-02.
    assert.throws(() => parseDateInput('2026-02-30'), /30 does not exist|has 28 days/);
    assert.throws(() => parseDateInput('2026-13-01'), /month 13/);
    assert.throws(() => parseDateInput('2026-00-10'), /month 0/);
    assert.throws(() => parseDateInput('2026-01-00'), /day 0/);
  });

  it('accepts a real leap day and refuses a fake one', () => {
    assert.equal(parseDateInput('2024-02-29').toICALString(), '20240229');
    assert.throws(() => parseDateInput('2026-02-29'), IcalError);
  });

  it('refuses an out-of-range time instead of rolling it over', () => {
    // Previously: "2026-01-01T25:00:00" silently became 2026-01-02T01:00:00.
    assert.throws(() => parseDateInput('2026-01-01T25:00:00'), /hour 25/);
    assert.throws(() => parseDateInput('2026-01-01T12:60:00'), /minute 60/);
    assert.throws(() => parseDateInput('2026-01-01T12:00:61'), /second 61/);
  });

  it('refuses a wall-clock time the zone skips for daylight saving', () => {
    // London jumps 01:00 -> 02:00 on 2026-03-29, so 01:30 never happens.
    assert.throws(
      () => parseDateInput('2026-03-29T01:30:00', 'Europe/London'),
      /does not exist in Europe\/London/,
    );
    // The hour either side is fine.
    assert.doesNotThrow(() => parseDateInput('2026-03-29T00:30:00', 'Europe/London'));
    assert.doesNotThrow(() => parseDateInput('2026-03-29T02:30:00', 'Europe/London'));
  });

  it('resolves an ambiguous fall-back time deterministically', () => {
    // London repeats 01:00-02:00 on 2026-10-25, so 01:30 happens twice: once as
    // BST (00:30Z) and once as GMT (01:30Z). The later instant is chosen, and
    // the point of the test is that it does not vary by machine.
    const time = parseDateInput('2026-10-25T01:30:00', 'Europe/London');
    assert.equal(time.toICALString(), '20261025T013000Z');
  });
});

describe('due-date ordering is independent of the process timezone (#6)', () => {
  it('resolves a zoned task date in its own zone, not as UTC', () => {
    // Previously read as 09:00Z; New York is UTC-5 in January.
    assert.equal(
      dateSortKey({ value: '2026-01-01T09:00:00', isDate: false, timezone: 'America/New_York' }),
      Date.parse('2026-01-01T14:00:00Z'),
    );
    assert.equal(
      dateSortKey({ value: '2026-07-01T09:00:00', isDate: false, timezone: 'Europe/London' }),
      Date.parse('2026-07-01T08:00:00Z'),
    );
  });

  it('orders a zoned task correctly against a UTC one', () => {
    const zoned = dateSortKey({
      value: '2026-01-01T09:00:00',
      isDate: false,
      timezone: 'America/New_York',
    })!;
    const utc = dateSortKey({ value: '2026-01-01T12:00:00Z', isDate: false })!;
    // 09:00 New York is 14:00Z, so it sorts after 12:00Z.
    assert.ok(zoned > utc, `${zoned} should be after ${utc}`);
  });

  it('reads a floating and a whole-day value as UTC, per the documented convention', () => {
    assert.equal(
      dateSortKey({ value: '2026-01-01T12:00:00', isDate: false }),
      Date.parse('2026-01-01T12:00:00Z'),
    );
    assert.equal(
      dateSortKey({ value: '2026-01-01', isDate: true }),
      Date.parse('2026-01-01T00:00:00Z'),
    );
  });
});

describe('recurrence detection covers RDATE-only series (#9)', () => {
  const rdateOnly = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:rdate-only
SUMMARY:Repeats on explicit dates
RDATE:20261001T090000Z,20261101T090000Z
END:VTODO
END:VCALENDAR`;

  it('marks an RDATE-only task as recurring', () => {
    const t = taskFromIcs(rdateOnly, { href: '/x', list: 'p' })!;
    assert.equal(t.recurring, true);
    assert.equal(t.recurrenceRule, undefined);
    assert.match(t.recurrenceDates!, /20261001T090000Z/);
  });

  it('still marks an RRULE task as recurring', () => {
    const ics = rdateOnly.replace('RDATE:20261001T090000Z,20261101T090000Z', 'RRULE:FREQ=WEEKLY');
    const t = taskFromIcs(ics, { href: '/x', list: 'p' })!;
    assert.equal(t.recurring, true);
    assert.match(t.recurrenceRule!, /FREQ=WEEKLY/);
  });

  it('leaves a one-off task non-recurring', () => {
    const t = taskFromIcs(FULL_VTODO, { href: '/x', list: 'p' })!;
    assert.equal(t.recurring, false);
  });
});

describe('date invariants are enforced before a write (#8)', () => {
  it('refuses a whole-day start with a timed due date', () => {
    assert.throws(
      () => buildTaskIcs('x', { summary: 'mixed', start: '2026-01-02', due: '2026-01-03T12:00:00Z' }),
      /same kind/,
    );
  });

  it('refuses a due date that is not after the start', () => {
    assert.throws(
      () => buildTaskIcs('x', { summary: 'backwards', start: '2026-01-02', due: '2026-01-01' }),
      /not later than/,
    );
    assert.throws(
      () =>
        buildTaskIcs('x', {
          summary: 'equal',
          start: '2026-01-02T09:00:00Z',
          due: '2026-01-02T09:00:00Z',
        }),
      /not later than/,
    );
  });

  it('refuses adding a due date to a task that has a DURATION', () => {
    const withDuration = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:x
DTSTART:20260101T120000Z
DURATION:PT1H
END:VTODO
END:VCALENDAR`;
    const calendar = parseCalendar(withDuration);
    assert.throws(
      () => applyEdits(findMasterVtodo(calendar)!, { due: '2026-01-02T12:00:00Z' }),
      /DURATION/,
    );
    // The duration is left in place rather than silently deleted.
    assert.match(serializeCalendar(calendar), /DURATION:PT1H/);
  });

  it('accepts a consistent pair', () => {
    assert.doesNotThrow(() =>
      buildTaskIcs('x', { summary: 'ok', start: '2026-01-02', due: '2026-01-03' }),
    );
    assert.doesNotThrow(() =>
      buildTaskIcs('x', {
        summary: 'ok',
        start: '2026-01-02T09:00:00Z',
        due: '2026-01-02T17:00:00Z',
      }),
    );
  });

  it('does not block an unrelated edit on an already-invalid task', () => {
    const invalid = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:x
DTSTART;VALUE=DATE:20260102
DUE:20260101T120000Z
END:VTODO
END:VCALENDAR`;
    const calendar = parseCalendar(invalid);
    // Another client wrote this; renaming it must still work.
    assert.doesNotThrow(() => applyEdits(findMasterVtodo(calendar)!, { summary: 'renamed' }));
    assert.match(serializeCalendar(calendar), /SUMMARY:renamed/);
  });
});

describe('date bounds do not depend on the process timezone (#6)', () => {
  it('reads a whole-day bound as UTC midnight', () => {
    assert.equal(dateBoundKey('2026-01-01'), Date.parse('2026-01-01T00:00:00Z'));
  });

  it('reads a floating bound as UTC, matching how task dates are read', () => {
    assert.equal(dateBoundKey('2026-01-01T12:00:00'), Date.parse('2026-01-01T12:00:00Z'));
    assert.equal(dateBoundKey('2026-01-01T12:00'), Date.parse('2026-01-01T12:00:00Z'));
  });

  it('reads an explicit UTC bound as that instant', () => {
    assert.equal(dateBoundKey('2026-01-01T12:00:00Z'), Date.parse('2026-01-01T12:00:00Z'));
  });

  it('agrees with dateSortKey so a bound and a task date are comparable', () => {
    assert.equal(
      dateBoundKey('2026-01-01'),
      dateSortKey({ value: '2026-01-01', isDate: true }),
    );
    assert.equal(
      dateBoundKey('2026-01-01T12:00:00'),
      dateSortKey({ value: '2026-01-01T12:00:00', isDate: false }),
    );
  });

  it('still rejects an impossible bound', () => {
    assert.throws(() => dateBoundKey('2026-02-30', 'dueBefore'), IcalError);
  });

  it('gives the same answer under two very different process timezones', async () => {
    // Previously this went through ical.js toJSDate(), which resolves floating
    // and whole-day values against the process TZ — a 14-hour spread between
    // London and Tokyo. Run in child processes, since Node caches the zone.
    const script =
      "import {dateBoundKey} from './src/api.ts';" +
      "console.log(JSON.stringify([dateBoundKey('2026-01-01')," +
      "dateBoundKey('2026-01-01T12:00:00')]));";
    const run = (tz: string): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', script],
          { cwd: process.cwd(), env: { ...process.env, TZ: tz } },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
        );
      });
    const [ny, tokyo] = await Promise.all([run('America/New_York'), run('Asia/Tokyo')]);
    assert.equal(ny, tokyo);
    assert.deepEqual(JSON.parse(ny), [
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2026-01-01T12:00:00Z'),
    ]);
  });
});

describe('list_tasks sort direction (#11)', () => {
  it('describes the direction it actually sorts in', () => {
    const tool = TOOLS.find((t) => t.name === 'list_tasks')!;
    assert.match(tool.description!, /earliest deadline first/);
    assert.doesNotMatch(tool.description!, /newest deadline first/);
  });

  it('puts the nearest deadline first and undated tasks last', () => {
    const keys = [
      dateSortKey({ value: '2026-03-01', isDate: true })!,
      dateSortKey({ value: '2026-01-01', isDate: true })!,
      dateSortKey(undefined) ?? Number.POSITIVE_INFINITY,
    ];
    const sorted = [...keys].sort((a, b) => a - b);
    assert.equal(sorted[0], dateSortKey({ value: '2026-01-01', isDate: true }));
    assert.equal(sorted[2], Number.POSITIVE_INFINITY);
  });
});

describe('timezone arguments require their date (#7)', () => {
  it('rejects a timezone-only update that would silently do nothing', async () => {
    const out = await callTool('update_task', { uid: 'x', dueTimezone: 'Europe/London' });
    assert.match(out, /Invalid arguments/);
    assert.match(out, /dueTimezone only applies to a due date/);
  });

  it('rejects a start timezone without a start date', async () => {
    const out = await callTool('update_task', { uid: 'x', startTimezone: 'Europe/London' });
    assert.match(out, /startTimezone only applies to a start date/);
  });

  it('rejects a timezone alongside clearing the date', async () => {
    const out = await callTool('update_task', {
      uid: 'x',
      due: null,
      dueTimezone: 'Europe/London',
    });
    assert.match(out, /cannot be used while clearing due/);
  });

  it('rejects the same combination on create_task', async () => {
    const out = await callTool('create_task', { summary: 'x', dueTimezone: 'Europe/London' });
    assert.match(out, /dueTimezone only applies to a due date/);
  });

  it('accepts a timezone given with its date', async () => {
    const out = await callTool('update_task', {
      uid: 'x',
      due: '2026-01-01T09:00:00',
      dueTimezone: 'Europe/London',
    });
    assert.doesNotMatch(out, /Invalid arguments/);
  });
});

// -----------------------------------------------------------------------------
// Redirect policy and UID ambiguity, against real local servers
// -----------------------------------------------------------------------------

/** Start an HTTP server on a loopback port and return it with its base URL. */
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testClient(baseUrl: string): NextcloudClient {
  return new NextcloudClient(
    loadConfig({
      NEXTCLOUD_URL: baseUrl,
      NEXTCLOUD_USER: 'alice',
      NEXTCLOUD_APP_PASSWORD: 'app-password',
      NEXTCLOUD_TIMEOUT_MS: '5000',
    }),
  );
}

describe('cross-origin redirects are refused (#10)', () => {
  it('does not fetch a redirect target on another origin', async () => {
    let sinkHits = 0;
    const sink = await startServer((_req, res) => {
      sinkHits++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('internal-only-data');
    });
    const origin = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${sink.url}/metadata` });
      res.end();
    });

    try {
      await assert.rejects(
        () => testClient(origin.url).dav('GET', '/dav'),
        (err: Error) => {
          assert.equal(err.name, 'RedirectRefusedError');
          assert.match(err.message, /leaves the configured Nextcloud origin/);
          return true;
        },
      );
      // The point of the fix: the request is never made at all.
      assert.equal(sinkHits, 0, 'the redirect target must never be contacted');
    } finally {
      await origin.close();
      await sink.close();
    }
  });

  it('does not forward a write body to a redirect target', async () => {
    let sinkBody = '';
    const sink = await startServer((req, res) => {
      req.on('data', (c) => (sinkBody += c));
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    const origin = await startServer((_req, res) => {
      res.writeHead(307, { Location: `${sink.url}/steal` });
      res.end();
    });

    try {
      await assert.rejects(
        () =>
          testClient(origin.url).putCalendarObject(
            '/dav/a.ics',
            'BEGIN:VCALENDAR\r\nSUMMARY:private\r\nEND:VCALENDAR',
          ),
        (err: Error) => err.name === 'RedirectRefusedError',
      );
      assert.equal(sinkBody, '', 'task content must not reach the redirect target');
    } finally {
      await origin.close();
      await sink.close();
    }
  });

  it('follows a redirect that stays on the configured origin', async () => {
    let served = 0;
    const origin = await startServer((req, res) => {
      if (req.url === '/dav') {
        res.writeHead(301, { Location: '/dav/' });
        res.end();
        return;
      }
      served++;
      res.writeHead(200, { 'Content-Type': 'text/plain', ETag: '"e1"' });
      res.end('arrived');
    });

    try {
      const result = await testClient(origin.url).dav('GET', '/dav');
      assert.equal(result.status, 200);
      assert.equal(result.body, 'arrived');
      assert.equal(served, 1);
    } finally {
      await origin.close();
    }
  });

  it('refuses a redirect loop rather than following it forever', async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(302, { Location: '/round-and-round' });
      res.end();
    });
    try {
      await assert.rejects(
        () => testClient(origin.url).dav('GET', '/dav'),
        (err: Error) => err.name === 'RedirectRefusedError',
      );
    } finally {
      await origin.close();
    }
  });
});

describe('an ambiguous uid is refused rather than guessed (#2)', () => {
  /** A CalDAV server with two task lists, both holding the given uid. */
  function davHandler(uid: string) {
    return (req: IncomingMessage, res: ServerResponse): void => {
      // Escaped before it is echoed into the response: the request path is
      // attacker-controlled even in a test fixture, and reflecting it raw is
      // both invalid XML and the shape of a reflected-XSS bug.
      const url = escapeXml(req.url ?? '');
      const send = (body: string): void => {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(body);
      };

      if (req.method === 'PROPFIND' && url === '/remote.php/dav/') {
        return send(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>
          <d:href>/remote.php/dav/</d:href><d:propstat><d:prop>
          <d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      }
      if (req.method === 'PROPFIND' && url.includes('/principals/')) {
        return send(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
          <d:href>${url}</d:href><d:propstat><d:prop>
          <c:calendar-home-set><d:href>/remote.php/dav/calendars/alice/</d:href></c:calendar-home-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      }
      if (req.method === 'PROPFIND' && url === '/remote.php/dav/calendars/alice/') {
        const calendar = (name: string): string => `<d:response>
          <d:href>/remote.php/dav/calendars/alice/${name}/</d:href><d:propstat><d:prop>
          <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
          <d:displayname>${name}</d:displayname>
          <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        return send(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          ${calendar('one')}${calendar('two')}</d:multistatus>`);
      }
      if (req.method === 'REPORT') {
        const list = url.includes('/one/') ? 'one' : 'two';
        const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:${uid}\nSUMMARY:copy in ${list}\nEND:VTODO\nEND:VCALENDAR`;
        return send(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
          <d:href>${url}${uid}.ics</d:href><d:propstat><d:prop>
          <d:getetag>"e-${list}"</d:getetag>
          <c:calendar-data>${ics.replace(/\n/g, '&#13;\n')}</c:calendar-data>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      }
      res.writeHead(404);
      res.end();
    };
  }

  it('reports both lists instead of silently picking one', async () => {
    const server = await startServer(davHandler('duplicate'));
    try {
      const api = new TasksApi(testClient(server.url));
      await assert.rejects(
        () => api.findTask('duplicate'),
        (err: Error) => {
          assert.equal(err.name, 'AmbiguousError');
          assert.match(err.message, /exists in 2 task lists/);
          assert.match(err.message, /one/);
          assert.match(err.message, /two/);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it('resolves normally once a list is named', async () => {
    const server = await startServer(davHandler('duplicate'));
    try {
      const api = new TasksApi(testClient(server.url));
      const { task, list } = await api.findTask('duplicate', 'two');
      assert.equal(list.uri, 'two');
      assert.equal(task.summary, 'copy in two');
    } finally {
      await server.close();
    }
  });

  it('refuses a delete it cannot aim unambiguously', async () => {
    const server = await startServer(davHandler('duplicate'));
    try {
      const api = new TasksApi(testClient(server.url));
      await assert.rejects(() => api.deleteTask('duplicate', undefined), /AmbiguousError|exists in 2/);
    } finally {
      await server.close();
    }
  });
});
