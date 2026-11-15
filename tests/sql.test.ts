import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The guard against ordering by a text cast.
//
// PostgreSQL resolves a bare name in ORDER BY to an output column of that name where the query has one, and only
// otherwise to the table's column; and a cast of a column is an output named after the column, with an alias or
// without one. So `SELECT id::text AS id FROM t ORDER BY id` and `SELECT id::text FROM t ORDER BY id` both order the
// text, where '10' sorts before '9', while `ORDER BY t.id` orders the numbers. The shape was corrected three times in
// this repo before this test was written, each time after it had passed on a fixture too small to show it. This test
// reads every SQL statement written under courier/ and tests/ and fails where an output that is a cast shares its
// name with a bare item of an ORDER BY of the same query.
//
// What is read, and the bound of the reading. Every string literal of a .ts file whose text begins with a statement
// keyword is a statement. A `${NAME}` inside one is replaced by the string constant NAME of the same file (the column
// lists are such constants), and any other `${…}` by a placeholder; a literal inside a template's `${…}` is not read
// on its own. A statement put together at run time from other pieces is outside this reading, and so is a file
// outside the two folders. Within a statement, every parenthesised group that is itself a query (a subquery, a CTE's
// body) is a query level of its own: its outputs are matched with its own ORDER BY and not the enclosing query's. Any
// other parenthesised group (an expression in parentheses, a call's arguments, a type's modifier) belongs to the
// query it is written in: `(id::text) AS id` and `CAST(id AS text) AS id` are casts of the enclosing query, named id,
// and so are `(id::text)` and `CAST(id AS text)` with no alias; an alias is read quoted or unquoted, and an ORDER BY
// inside a call (an aggregate's, a window's) is not the query's. The reading follows no types across levels: a column
// a subquery has already made text is text in the enclosing query with no cast in sight, and this test does not see
// that.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FOLDERS = ['courier', 'tests'] as const;
const STATEMENT = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|EXPLAIN|VACUUM|ANALYZE|ALTER|CREATE|DROP|TRUNCATE|SET|LOCK)\b/i;

// ──────────────────────────── the TypeScript side: the literals of a file ────────────────────────────

interface Literal {
  /** The text between the quotes, as written: a template's `${…}` kept. */
  text: string;
  /** The line the literal starts on. */
  line: number;
  /** The index of the opening quote in the source. */
  start: number;
}

function newlines(source: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (source.charAt(i) === '\n') n++;
  return n;
}

/** The index after the closing quote of a '…' or "…" literal opened at `i`, or -1 where a newline comes first (then it was not a literal). */
function quoted(source: string, i: number, quote: string): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source.charAt(j);
    if (ch === '\\') { j++; continue; }
    if (ch === '\n') return -1;
    if (ch === quote) return j + 1;
  }
  return -1;
}

/** The index after the closing backtick of a template opened at `i`; its `${…}` are stepped over whole. */
function template(source: string, i: number): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source.charAt(j);
    if (ch === '\\') { j++; continue; }
    if (ch === '`') return j + 1;
    if (ch === '$' && source.charAt(j + 1) === '{') { j = expression(source, j + 2) - 1; continue; }
  }
  return source.length;
}

/** The index after the `}` that closes a template's `${` whose body starts at `j`; strings, templates and comments inside are stepped over. */
function expression(source: string, j: number): number {
  let depth = 1;
  while (j < source.length) {
    const ch = source.charAt(j);
    const next = source.charAt(j + 1);
    if (ch === '{') { depth++; j++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return j + 1; j++; continue; }
    if (ch === '\'' || ch === '"') { const end = quoted(source, j, ch); j = end < 0 ? j + 1 : end; continue; }
    if (ch === '`') { j = template(source, j); continue; }
    if (ch === '/' && next === '/') { while (j < source.length && source.charAt(j) !== '\n') j++; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', j + 2); j = end < 0 ? source.length : end + 2; continue; }
    j++;
  }
  return source.length;
}

/** Every string literal of a TypeScript source with the line it starts on; comments are skipped. */
function literals(source: string): Literal[] {
  const out: Literal[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && next === '/') { while (i < source.length && source.charAt(i) !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += newlines(source, i, stop);
      i = stop;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const end = quoted(source, i, ch);
      if (end < 0) { i++; continue; }
      out.push({ text: source.slice(i + 1, end - 1), line, start: i });
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = template(source, i);
      out.push({ text: source.slice(i + 1, end - 1), line, start: i });
      line += newlines(source, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** The string constants of a file, `const NAME = '…'` at any depth, by name. */
function constants(source: string, lits: Literal[]): Map<string, string> {
  const byStart = new Map(lits.map((l) => [l.start, l.text]));
  const out = new Map<string, string>();
  for (const m of source.matchAll(/(?:^|[\n;{])[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?=['"`])/g)) {
    const text = byStart.get(m.index + m[0].length);
    if (text !== undefined) out.set(m[1] ?? '', text);
  }
  return out;
}

/** A template's text with `${NAME}` replaced by the file's constant NAME, and every other `${…}` by a placeholder. */
function resolved(text: string, consts: Map<string, string>, depth = 0): string {
  if (depth > 4) return text;
  return text
    .replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) => (consts.has(name) ? resolved(consts.get(name) ?? '', consts, depth + 1) : '$__'))
    .replace(/\$\{[^}]*\}/g, '$__');
}

interface Statement {
  /** The file, relative to the repo, with forward slashes. */
  file: string;
  /** The line the statement's literal starts on. */
  line: number;
  /** The line of the statement's first ORDER BY as written, where it has one. */
  orderBy: number | null;
  text: string;
}

function statementsOf(path: string): Statement[] {
  const source = readFileSync(path, 'utf8');
  const lits = literals(source);
  const consts = constants(source, lits);
  const file = relative(ROOT, path).split(sep).join('/');
  const out: Statement[] = [];
  for (const lit of lits) {
    const text = resolved(lit.text, consts);
    if (!STATEMENT.test(text)) continue;
    const at = lit.text.search(/ORDER\s+BY/i);
    out.push({ file, line: lit.line, orderBy: at < 0 ? null : lit.line + newlines(lit.text, 0, at), text });
  }
  return out;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const folder of FOLDERS) {
    for (const entry of readdirSync(join(ROOT, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(join(entry.parentPath, entry.name));
    }
  }
  return out.sort();
}

// ──────────────────────────── the SQL side: outputs that are casts, and bare ORDER BY items ────────────────────────────

/** The statement with its string literals emptied and its comments removed: names are then names. */
function bare(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A parenthesised group that is a query of its own, and so a level of its own. */
const QUERY = /^\s*(?:SELECT|WITH|VALUES|TABLE|INSERT|UPDATE|DELETE)\b/i;

/**
 * The query levels of a statement: the whole, and every parenthesised group that is itself a query, each with the
 * queries nested in it replaced by `(#)`. Every other parenthesised group stays in the text of the query it is written
 * in. A level's SELECT list and its ORDER BY are judged within the level.
 */
function levels(sql: string): string[] {
  const done: string[] = [];
  const open: string[] = [''];
  const close = (): void => {
    const group = open.pop() ?? '';
    if (QUERY.test(group)) { done.push(group); open[open.length - 1] += ' (#) '; } else open[open.length - 1] += `(${group})`;
  };
  for (const ch of sql) {
    if (ch === '(') { open.push(''); continue; }
    if (ch === ')') { if (open.length > 1) close(); continue; }
    open[open.length - 1] += ch;
  }
  while (open.length > 1) close();
  done.push(open[0] ?? '');
  return done;
}

/**
 * The text with everything inside its parentheses replaced by spaces, the parentheses kept: the same length as the
 * text, so an index found in the one reads the other. What is found in it is at the text's own depth: its commas, its
 * `AS`, its FROM and its ORDER BY, and not those of a call's arguments or a parenthesised expression.
 */
function surface(text: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '(') { out += depth === 0 ? '(' : ' '; depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += depth === 0 ? ')' : ' '; continue; }
    out += depth === 0 ? ch : ' ';
  }
  return out;
}

/** The pieces of `text` between `from` and `to`, split at the commas of its own depth, trimmed, the empty ones dropped. */
function items(text: string, from: number, to: number): string[] {
  const shape = surface(text);
  const out: string[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (shape.charAt(i) === ',') { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start, to));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** An identifier's name as PostgreSQL holds it: unquoted folded to lower case, quoted as written; null where the text is not one identifier. */
function identifier(text: string): string | null {
  const m = /^(?:"([^"]+)"|([A-Za-z_]\w*))$/.exec(text.trim());
  if (m === null) return null;
  return m[1] ?? (m[2] ?? '').toLowerCase();
}

/** A type as written after `::` or after CAST's AS: words, an optional modifier in parentheses, optional array brackets. */
const TYPE = /^\s*[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*(?:\s*\([^()]*\))?(?:\s*\[\s*\])*\s*$/;

/**
 * An expression unwrapped to what it casts: outer parentheses taken off, a trailing `::type` taken off, `CAST(… AS
 * type)` opened, again and again. `cast` says whether a cast was taken off; `column` is the name of the plain column
 * that was left, where one was, since that is what PostgreSQL names such an output after.
 */
function castOf(expr: string): { cast: boolean; column: string | null } {
  let cast = false;
  let e = expr.trim();
  for (let turn = 0; turn < 32; turn++) {
    const shape = surface(e);
    const wrapped = shape.startsWith('(') && shape.indexOf(')') === shape.length - 1;
    if (wrapped) { e = e.slice(1, -1).trim(); continue; }
    const at = shape.lastIndexOf('::');
    if (at >= 0 && TYPE.test(e.slice(at + 2))) { cast = true; e = e.slice(0, at).trim(); continue; }
    const call = /^CAST\s*\(/i.exec(shape);
    if (call !== null && shape.indexOf(')') === shape.length - 1) {
      const inner = e.slice(call[0].length, -1);
      let as: RegExpExecArray | null = null;
      for (const m of surface(inner).matchAll(/\sAS\s/gi)) as = m;
      if (as !== null && TYPE.test(inner.slice(as.index + as[0].length))) { cast = true; e = inner.slice(0, as.index).trim(); continue; }
    }
    break;
  }
  const m = /^(?:(?:"[^"]+"|[A-Za-z_]\w*)\s*\.\s*)?("[^"]+"|[A-Za-z_]\w*)$/.exec(e);
  return { cast, column: m === null ? null : identifier(m[1] ?? '') };
}

/** Where a SELECT list ends: the first clause keyword at the list's own depth. */
const LIST_END = /\b(?:FROM|WHERE|GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR|UNION|INTERSECT|EXCEPT|INTO)\b/i;

/**
 * The names of a level's outputs that are casts: an aliased item whose expression casts anywhere (a subquery's casts
 * are not seen, since a subquery is a level of its own), and an item with no alias that is a cast of a plain column,
 * in parentheses or not, by `::` or by CAST, named after the column.
 */
function castOutputs(level: string): Set<string> {
  const out = new Set<string>();
  const shape = surface(level);
  for (const m of shape.matchAll(/\bSELECT\b/gi)) {
    let from = m.index + m[0].length;
    const end = shape.slice(from).search(LIST_END);
    const to = end < 0 ? level.length : from + end;
    const distinctOn = /^\s*DISTINCT\s+ON\s*\(/i.exec(shape.slice(from, to));
    if (distinctOn !== null) {
      from = shape.indexOf(')', from + distinctOn[0].length) + 1;
    } else {
      const plain = /^\s*(?:DISTINCT|ALL)\s+/i.exec(shape.slice(from, to));
      if (plain !== null) from += plain[0].length;
    }
    for (const item of items(level, from, to)) {
      let alias: RegExpExecArray | null = null;
      for (const a of surface(item).matchAll(/\sAS\s+("[^"]+"|[A-Za-z_]\w*)\s*$/gi)) alias = a;
      if (alias !== null) {
        const name = identifier(alias[1] ?? '');
        if (name !== null && /::|\bCAST\s*\(/i.test(item.slice(0, alias.index))) out.add(name);
        continue;
      }
      const c = castOf(item);
      if (c.cast && c.column !== null) out.add(c.column);
    }
  }
  return out;
}

/** Where an ORDER BY list ends. */
const ORDER_END = /\b(?:LIMIT|OFFSET|FETCH|FOR|UNION|INTERSECT|EXCEPT|RETURNING|WINDOW|ON)\b|;/i;

/** The bare names among a level's ORDER BY items: one identifier, quoted or not; not a qualified column, a position or an expression. */
function bareOrderBy(level: string): string[] {
  const out: string[] = [];
  const shape = surface(level);
  for (const m of shape.matchAll(/\bORDER\s+BY\b/gi)) {
    const from = m.index + m[0].length;
    const end = shape.slice(from).search(ORDER_END);
    const to = end < 0 ? level.length : from + end;
    for (const item of items(level, from, to)) {
      const name = identifier(item.replace(/\b(?:ASC|DESC|NULLS\s+(?:FIRST|LAST)|USING\s+\S+)\b/gi, ''));
      if (name !== null) out.push(name);
    }
  }
  return out;
}

/** The outputs of a statement that are casts and that a bare ORDER BY item of the same level names: the shape this test exists for. */
export function castsOrderedBare(sql: string): string[] {
  const hits: string[] = [];
  for (const level of levels(bare(sql))) {
    const outputs = castOutputs(level);
    if (outputs.size === 0) continue;
    for (const name of bareOrderBy(level)) if (outputs.has(name)) hits.push(name);
  }
  return hits;
}

// ──────────────────────────── the tests ────────────────────────────

test('the reading: each shape that was corrected is found, a cast with no alias among them, and the qualified and the uncast forms are not', () => {
  // The shapes are put together here, so this file holds no statement of the shape for the guard below to read.
  const cast = (column: string) => `${column}::text AS ${column}`;
  const uncast = (column: string) => `${column}::text`;
  assert.deepEqual(castsOrderedBare(`SELECT hash, ${cast('expiry')}, ${cast('record_number')} FROM orders WHERE account = $1 ORDER BY expiry DESC, record_number DESC LIMIT $4`), ['expiry', 'record_number'], "the door's page, as it first stood");
  assert.deepEqual(castsOrderedBare(`SELECT e.${cast('number')}, e.kind, e.${cast('run')} FROM events e WHERE e.kind = $1 ORDER BY number`), ['number'], 'the condition lines, as they first stood');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('id')}, xmin::text AS version, key FROM conditions ORDER BY id`), ['id'], 'the condition rows, as they first stood');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('record_number')}, ended FROM orders WHERE record_number BETWEEN 9990 AND 10015 ORDER BY record_number`), ['record_number'], 'the planted page, as it stood');
  assert.deepEqual(castsOrderedBare(`SELECT ${uncast('id')}, key FROM conditions ORDER BY id`), ['id'], 'no alias: the cast is named after its column all the same');
  assert.deepEqual(castsOrderedBare(`SELECT c.${uncast('id')}, c.key FROM conditions c ORDER BY id DESC, key`), ['id'], 'a qualified column, cast with no alias, is named after the column');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('id')}, key FROM conditions ORDER BY conditions.id`), [], 'named with the table, the ORDER BY is the column');
  assert.deepEqual(castsOrderedBare('SELECT id, key FROM conditions ORDER BY id'), [], 'no cast: the output is the column itself');
  assert.deepEqual(castsOrderedBare('SELECT ended_block::text AS block FROM orders ORDER BY record_number'), [], 'another name: nothing is shadowed');
  assert.deepEqual(castsOrderedBare("SELECT json_build_object('nonce', l.nonce::text) AS row FROM live l ORDER BY nonce"), [], "a cast inside a call: the output is the alias, not the cast's column");
  assert.deepEqual(castsOrderedBare('SELECT (SELECT record_number FROM scanned ORDER BY record_number DESC LIMIT 1)::text AS last_record, count(*)::int AS n FROM scanned'), [], "a subquery's ORDER BY is its own level");
  assert.deepEqual(castsOrderedBare('SELECT max(number) AS number FROM events ORDER BY number'), [], 'an alias with no cast is not this shape');
  assert.deepEqual(castsOrderedBare("SELECT kind FROM events WHERE reason = 'ORDER BY number::text AS number' ORDER BY number"), [], 'a string literal is not read');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('id')} FROM conditions ORDER BY 1`), [], 'a position is not a name');
});

test('the reading: a cast in parentheses, a CAST call and a quoted alias are casts of the query they are written in', () => {
  // Put together here as above, so this file holds none of these shapes either.
  const cast = (column: string) => `${column}::text AS ${column}`;
  const inParens = (column: string) => `(${column}::text) AS ${column}`;
  const byCall = (column: string) => `CAST(${column} AS text) AS ${column}`;
  const quotedAlias = (column: string, alias = column) => `${column}::text AS "${alias}"`;
  const parensOnly = (column: string) => `(${column}::text)`;
  const callOnly = (column: string) => `CAST(${column} AS text)`;
  const castAlias = (expr: string, column: string) => `${expr}::int AS ${column}`;
  assert.deepEqual(castsOrderedBare(`SELECT ${inParens('record_number')}, ended FROM orders WHERE record_number BETWEEN 9990 AND 10015 ORDER BY record_number`), ['record_number'], 'a cast in parentheses, aliased to its own name');
  assert.deepEqual(castsOrderedBare(`SELECT ${byCall('record_number')}, ended FROM orders WHERE record_number BETWEEN 9990 AND 10015 ORDER BY record_number`), ['record_number'], 'CAST(… AS text), aliased to its own name');
  assert.deepEqual(castsOrderedBare(`SELECT ${quotedAlias('record_number')}, ended FROM orders WHERE record_number BETWEEN 9990 AND 10015 ORDER BY record_number`), ['record_number'], 'a quoted alias is the same name');
  assert.deepEqual(castsOrderedBare(`SELECT ${parensOnly('id')}, key FROM conditions ORDER BY id`), ['id'], 'a cast in parentheses with no alias is named after its column');
  assert.deepEqual(castsOrderedBare(`SELECT ${callOnly('id')}, key FROM conditions ORDER BY id`), ['id'], 'CAST(… AS text) with no alias is named after its column');
  assert.deepEqual(castsOrderedBare(`SELECT ${callOnly('c.id')}, c.key FROM conditions c ORDER BY id`), ['id'], 'CAST of a qualified column with no alias is named after the column');
  assert.deepEqual(castsOrderedBare(`SELECT ((${callOnly('id')}))::varchar, key FROM conditions ORDER BY id`), ['id'], 'the forms nested: parentheses around a CAST, cast again');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('id')}, key FROM conditions ORDER BY "id"`), ['id'], 'a quoted ORDER BY item is a bare name too');
  assert.deepEqual(castsOrderedBare(`SELECT ${quotedAlias('id', 'Id')}, key FROM conditions ORDER BY id`), [], 'a quoted alias in another case is another name');
  assert.deepEqual(castsOrderedBare(`SELECT ${inParens('id')}, key FROM conditions ORDER BY conditions.id`), [], 'in parentheses, named with the table: the ORDER BY is the column');
  assert.deepEqual(castsOrderedBare('SELECT (id::text) AS id_text, key FROM conditions ORDER BY id'), [], 'in parentheses, another name: nothing is shadowed');
  assert.deepEqual(castsOrderedBare('SELECT (id), key FROM conditions ORDER BY id'), [], 'parentheses with no cast: the output is the column itself');
  assert.deepEqual(castsOrderedBare('SELECT (id + 1)::text, key FROM conditions ORDER BY id'), [], 'a cast of an expression with no alias has no column to be named after');
  assert.deepEqual(castsOrderedBare(`SELECT array_agg(key ORDER BY id) AS keys, ${cast('id')} FROM conditions GROUP BY id`), [], "an ORDER BY inside a call is the call's, not the query's");
  assert.deepEqual(castsOrderedBare(`SELECT DISTINCT ON (account) account, ${cast('id')} FROM conditions ORDER BY account, id`), ['id'], "DISTINCT ON's list is not an output; the items after it are");
  assert.deepEqual(castsOrderedBare(`SELECT ${castAlias('coalesce((SELECT max(id) FROM conditions), 0)', 'id')} FROM events ORDER BY id`), ['id'], "a subquery inside a call is its own level; the cast around the call is the query's");
});

test('the guard: no SQL statement under courier/ or tests/ orders by a bare name that one of its cast outputs carries', () => {
  const files = sourceFiles();
  const statements = files.flatMap(statementsOf);
  const hits = statements.flatMap((s) =>
    castsOrderedBare(s.text).map((name) => `${s.file}:${s.line}${s.orderBy === null ? '' : ` (ORDER BY at line ${s.orderBy})`}: the output "${name}" is a cast, and ORDER BY names it bare`),
  );
  // The reading read what is there: the files, the statements, and a statement whose column list is a constant of its
  // file, resolved into it. Without these a reading that found nothing would pass as a clean one.
  assert.ok(files.length >= 20, `${files.length} files read`);
  assert.ok(statements.length >= 60, `${statements.length} statements read`);
  assert.ok(statements.some((s) => /FROM orders WHERE hash = \$1/.test(s.text) && /record_number,\s+received_at/.test(s.text)), "the orders' column list, a constant of its file, was resolved into the statement that reads one order");
  console.log(`sql guard: ${files.length} files, ${statements.length} statements, ${hits.length} hits`);
  assert.deepEqual(hits, []);
});
