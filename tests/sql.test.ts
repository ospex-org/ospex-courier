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
// outside the two folders. Within a statement, every parenthesised group is a query level of its own: a subquery's
// outputs are matched with its own ORDER BY and not the enclosing query's, and an ORDER BY inside a call (an
// aggregate's, a window's) belongs to a level with no outputs. The reading follows no types across levels: a column a
// subquery has already made text is text in the enclosing query with no cast in sight, and this test does not see
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

/**
 * The query levels of a statement: the whole, and every parenthesised group, each with its own nested groups
 * replaced by `(#)`. A group's SELECT list and its ORDER BY are judged within the group.
 */
function levels(sql: string): string[] {
  const done: string[] = [];
  const open: string[] = [''];
  for (const ch of sql) {
    if (ch === '(') { open.push(''); continue; }
    if (ch === ')') {
      if (open.length > 1) { done.push(open.pop() ?? ''); open[open.length - 1] += ' (#) '; }
      continue;
    }
    open[open.length - 1] += ch;
  }
  while (open.length > 1) done.push(open.pop() ?? '');
  done.push(open[0] ?? '');
  return done;
}

/** The names of a level's outputs that are casts: an explicit alias, or the column's own name for a cast of a plain column. */
function castOutputs(level: string): Set<string> {
  const out = new Set<string>();
  for (const m of level.matchAll(/\bSELECT\b/gi)) {
    let rest = level.slice(m.index + m[0].length);
    const from = rest.search(/\bFROM\b/i);
    if (from >= 0) rest = rest.slice(0, from);
    rest = rest.replace(/^\s*(?:DISTINCT(?:\s+ON\s*\(#\))?|ALL)\s+/i, '');
    for (const item of rest.split(',').map((s) => s.trim())) {
      const aliased = /^(.*?)\s+AS\s+([A-Za-z_]\w*)$/is.exec(item);
      if (aliased !== null) {
        if ((aliased[1] ?? '').includes('::')) out.add((aliased[2] ?? '').toLowerCase());
        continue;
      }
      const implicit = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)(?:::[A-Za-z_]\w*(?:\[\])?)+$/i.exec(item);
      if (implicit !== null) out.add((implicit[1] ?? '').toLowerCase());
    }
  }
  return out;
}

/** The bare names among a level's ORDER BY items: a plain identifier, not a qualified column, a position or an expression. */
function bareOrderBy(level: string): string[] {
  const out: string[] = [];
  for (const m of level.matchAll(/\bORDER\s+BY\b/gi)) {
    let list = level.slice(m.index + m[0].length);
    const end = list.search(/\b(?:LIMIT|OFFSET|FETCH|FOR|UNION|INTERSECT|EXCEPT|RETURNING|WINDOW|ON)\b|;/i);
    if (end >= 0) list = list.slice(0, end);
    for (const item of list.split(',')) {
      const name = item.replace(/\b(?:ASC|DESC|NULLS\s+(?:FIRST|LAST)|USING\s+\S+)\b/gi, '').trim();
      if (/^[A-Za-z_]\w*$/.test(name)) out.push(name.toLowerCase());
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
  assert.deepEqual(castsOrderedBare("SELECT json_build_object('nonce', l.nonce::text) AS row FROM live l ORDER BY nonce"), [], 'a cast inside a call names no output');
  assert.deepEqual(castsOrderedBare('SELECT (SELECT record_number FROM scanned ORDER BY record_number DESC LIMIT 1)::text AS last_record, count(*)::int AS n FROM scanned'), [], "a subquery's ORDER BY is its own level");
  assert.deepEqual(castsOrderedBare('SELECT max(number) AS number FROM events ORDER BY number'), [], 'an alias with no cast is not this shape');
  assert.deepEqual(castsOrderedBare("SELECT kind FROM events WHERE reason = 'ORDER BY number::text AS number' ORDER BY number"), [], 'a string literal is not read');
  assert.deepEqual(castsOrderedBare(`SELECT ${cast('id')} FROM conditions ORDER BY 1`), [], 'a position is not a name');
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
