/**
 * A minimal, namespace-aware XML reader for WebDAV multistatus documents.
 *
 * WebDAV is the one Nextcloud API that cannot be read with a regex. Three
 * properties of the format force a real parser:
 *
 *  - **Prefixes are not names.** `DAV:` may arrive as `d:`, `D:` or the default
 *    namespace, and CalDAV as `cal:`, `c:` or `C:`. sabre/dav picks them per
 *    response, so matching on `<d:href>` works until the day it does not.
 *  - **`propstat` is per-status.** One `response` carries a 200 block and a 404
 *    block; a flat scan reads properties out of the 404 block as though the
 *    server had returned them.
 *  - **`calendar-data` holds XML-escaped iCalendar.** A task whose description
 *    contains `<`, `&` or `]]>` arrives escaped, and anything that slices the
 *    body out by hand has to unescape it correctly or silently corrupt the
 *    task it is about to write back.
 *
 * The parser is deliberately small: elements, attributes, text, CDATA,
 * comments, processing instructions and the five predefined entities plus
 * numeric character references. It does not resolve DTDs or external entities,
 * which is a security property worth keeping rather than a limitation to fix.
 */

export interface XmlElement {
  /** Resolved namespace URI, or `''` when the element is in no namespace. */
  ns: string;
  /** Local name, with any prefix stripped. */
  name: string;
  /** Attributes by local name. Namespaced attributes keep their prefix. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content, with entities and CDATA resolved. */
  text: string;
}

/** Namespace URIs used by the CalDAV requests this server makes. */
export const NS = {
  dav: 'DAV:',
  caldav: 'urn:ietf:params:xml:ns:caldav',
  carddav: 'urn:ietf:params:xml:ns:carddav',
  owncloud: 'http://owncloud.org/ns',
  nextcloud: 'http://nextcloud.com/ns',
  apple: 'http://apple.com/ns/ical/',
} as const;

/**
 * Cap on nesting depth.
 *
 * A multistatus document is three or four levels deep; anything approaching
 * this is malformed or hostile, and the limit keeps a pathological document
 * from exhausting the stack.
 */
const MAX_DEPTH = 100;

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * Resolve the five predefined entities and numeric character references.
 *
 * An unrecognised entity is left verbatim rather than dropped: in a WebDAV
 * response it is far more likely to be a literal `&` the server failed to
 * escape than a DTD entity, and preserving it keeps a task description intact.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** `String.fromCodePoint` throws on a lone surrogate; keep the literal instead. */
function safeFromCodePoint(code: number): string {
  if (code >= 0xd800 && code <= 0xdfff) return `&#${code};`;
  try {
    return String.fromCodePoint(code);
  } catch {
    return `&#${code};`;
  }
}

/** Escape text for inclusion in an XML element or attribute value. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A document that could not be parsed. Carries a snippet for diagnosis. */
export class XmlParseError extends Error {
  constructor(message: string, source: string, offset: number) {
    const from = Math.max(0, offset - 40);
    const snippet = source.slice(from, offset + 40).replace(/\s+/g, ' ');
    super(`${message} at offset ${offset} (…${snippet}…)`);
    this.name = 'XmlParseError';
  }
}

interface Frame {
  element: XmlElement;
  /** Prefix → namespace URI, inherited from the parent and extended here. */
  scope: Record<string, string>;
  /** Raw qualified name, kept so a mismatched close tag can be reported. */
  qname: string;
}

/**
 * Parse an XML document and return its root element.
 *
 * Throws {@link XmlParseError} on malformed input rather than returning a
 * partial tree: a truncated multistatus that parses to "no responses" is
 * indistinguishable from an empty task list, and silently reporting the wrong
 * one of those is worse than failing.
 */
export function parseXml(source: string): XmlElement {
  let pos = 0;
  const stack: Frame[] = [];
  let root: XmlElement | null = null;

  const fail = (message: string): never => {
    throw new XmlParseError(message, source, pos);
  };

  while (pos < source.length) {
    const lt = source.indexOf('<', pos);

    if (lt === -1) {
      // Trailing character data. Only whitespace may follow the root element.
      appendText(stack, source.slice(pos), fail);
      break;
    }

    if (lt > pos) appendText(stack, source.slice(pos, lt), fail);
    pos = lt;

    // <?xml … ?> and other processing instructions.
    if (source.startsWith('<?', pos)) {
      const end = source.indexOf('?>', pos + 2);
      if (end === -1) fail('Unterminated processing instruction');
      pos = end + 2;
      continue;
    }

    // <!-- … -->, <![CDATA[ … ]]>, <!DOCTYPE …>
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      if (end === -1) fail('Unterminated comment');
      pos = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', pos)) {
      const end = source.indexOf(']]>', pos + 9);
      if (end === -1) fail('Unterminated CDATA section');
      // CDATA is literal: appended without entity resolution.
      appendRawText(stack, source.slice(pos + 9, end), fail);
      pos = end + 3;
      continue;
    }
    if (source.startsWith('<!', pos)) {
      // A DOCTYPE. Skipped without interpreting it — no entity expansion, and
      // therefore no billion-laughs or external-entity exposure.
      const end = skipDoctype(source, pos);
      if (end === -1) fail('Unterminated declaration');
      pos = end;
      continue;
    }

    // Closing tag.
    if (source.startsWith('</', pos)) {
      const end = source.indexOf('>', pos + 2);
      if (end === -1) fail('Unterminated closing tag');
      const qname = source.slice(pos + 2, end).trim();
      const frame = stack.pop();
      if (!frame) fail(`Unexpected closing tag </${qname}>`);
      if (frame!.qname !== qname) {
        fail(`Mismatched closing tag: expected </${frame!.qname}>, got </${qname}>`);
      }
      pos = end + 1;
      continue;
    }

    // Opening tag. Find its end, skipping any '>' inside an attribute value.
    const tagEnd = findTagEnd(source, pos);
    if (tagEnd === -1) fail('Unterminated opening tag');
    const raw = source.slice(pos + 1, tagEnd);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;

    const { qname, attrs } = parseTag(body, source, pos);
    if (qname === '') fail('Empty tag name');

    const parentScope = stack.length > 0 ? stack[stack.length - 1]!.scope : {};
    const scope = extendScope(parentScope, attrs);
    const { ns, local } = resolveName(qname, scope, false);

    const element: XmlElement = {
      ns,
      name: local,
      attrs: plainAttrs(attrs),
      children: [],
      text: '',
    };

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.element.children.push(element);
    } else if (root) {
      fail('Document has more than one root element');
    } else {
      root = element;
    }

    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) fail(`Nesting deeper than ${MAX_DEPTH} elements`);
      stack.push({ element, scope, qname });
    }
    pos = tagEnd + 1;
  }

  if (stack.length > 0) {
    throw new XmlParseError(`Unclosed element <${stack[stack.length - 1]!.qname}>`, source, pos);
  }
  if (!root) throw new XmlParseError('Document has no root element', source, 0);
  return root;
}

/**
 * Character data outside the root element is an error, not noise.
 *
 * XML permits only whitespace (and a leading BOM) around the document element.
 * Ignoring anything else lets a truncated response, or an HTML error page a
 * proxy concatenated onto one, parse into a plausible-looking tree — exactly
 * the failure the parser exists to make impossible. A `multistatus` recovered
 * from half a document reports "no tasks", which is indistinguishable from an
 * empty list and far worse than an error.
 */
function appendText(stack: Frame[], text: string, fail: (message: string) => never): void {
  if (stack.length === 0) {
    // U+FEFF is a byte-order mark, legal before the declaration and not content.
    if (text.replace(/﻿/g, '').trim() !== '') {
      fail('Character data outside the root element');
    }
    return;
  }
  stack[stack.length - 1]!.element.text += decodeEntities(text);
}

function appendRawText(stack: Frame[], text: string, fail: (message: string) => never): void {
  if (stack.length === 0) {
    // A CDATA section is content by definition, so it can never sit at the top
    // level — unlike whitespace, there is no benign reading of it here.
    fail('CDATA section outside the root element');
  }
  stack[stack.length - 1]!.element.text += text;
}

/**
 * Skip a `<!DOCTYPE …>` declaration, including an internal subset.
 *
 * Returns the offset just past the closing `>`, or -1 if unterminated.
 */
function skipDoctype(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return i + 1;
  }
  return -1;
}

/** Offset of the `>` ending the tag that starts at `start`, ignoring quoted values. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const NAME_START = /[A-Za-z_:]/;

/** Split a tag body into its qualified name and its raw attributes. */
function parseTag(
  body: string,
  source: string,
  offset: number,
): { qname: string; attrs: Record<string, string> } {
  let i = 0;
  while (i < body.length && !/\s/.test(body[i]!)) i++;
  const qname = body.slice(0, i);
  const attrs: Record<string, string> = {};

  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    if (!NAME_START.test(body[i]!)) {
      throw new XmlParseError(`Invalid attribute name in <${qname}>`, source, offset);
    }
    const nameStart = i;
    while (i < body.length && !/[\s=]/.test(body[i]!)) i++;
    const name = body.slice(nameStart, i);

    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== '=') {
      throw new XmlParseError(`Attribute ${name} has no value in <${qname}>`, source, offset);
    }
    i++;
    while (i < body.length && /\s/.test(body[i]!)) i++;

    const quote = body[i];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`Attribute ${name} is not quoted in <${qname}>`, source, offset);
    }
    i++;
    const valueStart = i;
    while (i < body.length && body[i] !== quote) i++;
    if (i >= body.length) {
      throw new XmlParseError(`Unterminated value for ${name} in <${qname}>`, source, offset);
    }
    attrs[name] = decodeEntities(body.slice(valueStart, i));
    i++;
  }

  return { qname, attrs };
}

/** Add any `xmlns` declarations on this element to the inherited scope. */
function extendScope(
  parent: Record<string, string>,
  attrs: Record<string, string>,
): Record<string, string> {
  let scope = parent;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'xmlns') {
      if (scope === parent) scope = { ...parent };
      scope[''] = value;
    } else if (key.startsWith('xmlns:')) {
      if (scope === parent) scope = { ...parent };
      scope[key.slice(6)] = value;
    }
  }
  return scope;
}

/** Attributes with the namespace declarations removed. */
function plainAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    const colon = key.indexOf(':');
    out[colon === -1 ? key : key.slice(colon + 1)] = value;
  }
  return out;
}

/**
 * Split a qualified name into namespace URI and local name.
 *
 * An unbound prefix resolves to no namespace rather than throwing: a server
 * that emits one is malformed, but the remaining properties in the document
 * are still worth reading.
 */
function resolveName(
  qname: string,
  scope: Record<string, string>,
  isAttribute: boolean,
): { ns: string; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) {
    // An unprefixed attribute is in no namespace, even with a default xmlns.
    return { ns: isAttribute ? '' : (scope[''] ?? ''), local: qname };
  }
  const prefix = qname.slice(0, colon);
  return { ns: scope[prefix] ?? '', local: qname.slice(colon + 1) };
}

// -----------------------------------------------------------------------------
// Tree helpers
// -----------------------------------------------------------------------------

/** Direct children matching a namespace and local name. */
export function findAll(element: XmlElement, ns: string, name: string): XmlElement[] {
  return element.children.filter((c) => c.ns === ns && c.name === name);
}

/** First direct child matching a namespace and local name, or undefined. */
export function find(element: XmlElement, ns: string, name: string): XmlElement | undefined {
  return element.children.find((c) => c.ns === ns && c.name === name);
}

/** Text of the first matching direct child, trimmed; undefined when absent. */
export function findText(element: XmlElement, ns: string, name: string): string | undefined {
  const child = find(element, ns, name);
  return child === undefined ? undefined : child.text.trim();
}
