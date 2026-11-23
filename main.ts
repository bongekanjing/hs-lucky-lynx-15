// mend: one patch tool for every AI edit format. Implements SPEC.md version 1.
// Node 22 and the standard library alone; nothing is installed before the program runs.
//
// Four readers turn a patch into edits over one virtual tree: unified diffs with unreliable line numbers,
// SEARCH/REPLACE blocks, V4A patches and JSON text-editor calls. Lines are matched at three tiers (exact, then
// trailing whitespace ignored, then both sides ignored), context lines are always taken from the file itself, and
// the tree is written only when every edit succeeded.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type Kind = 'ctx' | 'old' | 'new' | 'bs';

interface Item {
  k: Kind;
  t: string;
}

interface Hunk {
  a: number;
  body: Item[];
}

interface Section {
  old: string | null;
  new: string | null;
  hunks: Hunk[];
  create: boolean;
  del: boolean;
}

interface Chunk {
  anchor: string | null;
  body: Item[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

interface Move {
  old: string;
  new: string;
}

interface Row {
  key: string;
  text: string;
}

type Edit = (tree: Tree) => void;

const isBlank = (s: string): boolean => s.trim() === '';

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A patch's lines: split at a line feed, one trailing carriage return removed, no empty piece after a final feed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as its line break, its lines and whether it ends with one. */
function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (parts[parts.length - 1] === '') {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** One line at a tier: 0 as it is, 1 without trailing spaces and tabs, 2 without either side. */
function norm(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const want = old.map((l) => norm(tier, l));
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < old.length; j += 1) {
      if (norm(tier, lines[i + j]!) !== want[j]!) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/** The first tier, 0 first, at which `old` occurs at or after `from`. */
function firstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const pos = occurrences(lines, old, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The tree the edits build: `orig` is what the disk held, `now` every path an edit touched (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) this.orig.set(p, fileExists(p) ? readFileSync(p, 'utf8') : null);
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

function oldLines(body: Item[]): string[] {
  return body.filter((i) => i.k === 'ctx' || i.k === 'old').map((i) => i.t);
}

function newCount(body: Item[]): number {
  let n = 0;
  for (const it of body) if (it.k === 'ctx' || it.k === 'new') n += 1;
  return n;
}

/** A backslash line refers to the body line before it, so only a trailing one can drop the final break. */
function dropsFinalBreak(body: Item[]): boolean {
  let last = -1;
  body.forEach((it, i) => {
    if (it.k === 'ctx' || it.k === 'new') last = i;
  });
  return last >= 0 && last + 1 < body.length && body[last + 1]!.k === 'bs';
}

/** N in place of O at `at`; context lines are written from the file, new lines from the patch. */
function splice(lines: string[], at: number, body: Item[], tier: number, old: string[]): string[] {
  const mid: string[] = [];
  let oi = 0;
  for (const it of body) {
    if (it.k === 'ctx') {
      mid.push(lines[at + oi]!);
      oi += 1;
    } else if (it.k === 'old') {
      oi += 1;
    } else if (it.k === 'new') {
      let t = it.t;
      if (tier === 2 && old.length > 0 && t.trim() !== '') {
        const f = leadWs(lines[at]!);
        const p = leadWs(old[0]!);
        if (t.startsWith(p)) t = f + t.slice(p.length);
      }
      mid.push(t);
    }
  }
  return [...lines.slice(0, at), ...mid, ...lines.slice(at + old.length)];
}

/** A section's hunks in order, each against the result of the ones before, offset by their drift so far. */
function applyHunks(doc: Doc, hunks: Hunk[], path: string, strict: boolean): Doc {
  let lines = doc.lines.slice();
  let final = doc.final;
  let drift = 0;
  for (const h of hunks) {
    const old = oldLines(h.body);
    let at: number;
    let tier = 0;
    if (old.length > 0) {
      const found = firstTier(lines, old, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.a - 1 + drift;
      at = found.pos[0]!;
      for (const p of found.pos) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
    } else {
      at = Math.min(Math.max(h.a + drift, 0), lines.length);
    }
    const runsToEnd = at + old.length === lines.length;
    const next = splice(lines, at, h.body, tier, old);
    if (runsToEnd) final = !dropsFinalBreak(h.body);
    drift += newCount(h.body) - old.length;
    lines = next;
  }
  return { lines, br: doc.br, final };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A path from a --- / +++ header: the text after four characters, to the first tab, trimmed, a/ or b/ dropped. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function startsSection(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    let cur: Section;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, new: m[2]!, hunks: [], create: false, del: false };
      sections.push(cur);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { old: headerPath(line), new: headerPath(lines[i + 1]!), hunks: [], create: false, del: false };
      sections.push(cur);
      i += 2;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }

    // The section header, up to its first hunk. Paths resolve afterwards by precedence: a ---/+++ pair, then
    // rename lines, then the diff --git paths.
    let pair: { old: string | null; new: string | null } | null = null;
    let rename: { from: string | null; to: string | null } = { from: null, to: null };
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@') || h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        // A second pair starts a new section; the first one names this section's paths.
        if (pair !== null) break;
        pair = { old: headerPath(h), new: headerPath(lines[i + 1]!) };
        i += 2;
        continue;
      }
      if (h.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (h.startsWith('+++ ')) {
        pair = { old: pair === null ? null : pair.old, new: headerPath(h) };
        i += 1;
        continue;
      }
      if (h.startsWith('rename from ')) {
        rename.from = h.slice(12).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        rename.to = h.slice(10).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    if (pair !== null) {
      cur.old = pair.old;
      cur.new = pair.new;
    } else if (rename.from !== null || rename.to !== null) {
      cur.old = rename.from;
      cur.new = rename.to;
    }

    // The section's hunks.
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ') || startsSection(lines, i)) break;
      if (!h.startsWith('@@')) {
        i += 1;
        continue;
      }
      const m = HUNK_HEAD.exec(h);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b === '') {
          hunk.body.push({ k: 'ctx', t: '' });
          i += 1;
          continue;
        }
        if (b.startsWith('diff --git ') || startsSection(lines, i)) break;
        const c = b[0];
        if (c === ' ') hunk.body.push({ k: 'ctx', t: b.slice(1) });
        else if (c === '-') hunk.body.push({ k: 'old', t: b.slice(1) });
        else if (c === '+') hunk.body.push({ k: 'new', t: b.slice(1) });
        else if (c === '\\') hunk.body.push({ k: 'bs', t: '' });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.k === 'ctx' && last.t === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => (tree: Tree) => {
    const created = sec.old === null || sec.create;
    if (created) {
      const p = sec.new!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const rows: string[] = [];
      for (const h of sec.hunks) for (const it of h.body) if (it.k === 'new') rows.push(it.t);
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
        const body = sec.hunks[k]!.body;
        if (body.some((it) => it.k === 'new')) {
          final = !dropsFinalBreak(body);
          break;
        }
      }
      tree.now.set(p, rows.length === 0 ? '' : rows.join('\n') + (final ? '\n' : ''));
      return;
    }

    const from = sec.old;
    if (!isSafe(from)) throw new Fail('unsafe', from);

    if (sec.new === null || sec.del) {
      if (tree.get(from) === null) throw new Fail('missing', from);
      tree.now.set(from, null);
      return;
    }

    const to = sec.new;
    if (to !== from) {
      if (!isSafe(to)) throw new Fail('unsafe', to);
      if (tree.get(from) === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
    } else if (tree.get(from) === null) {
      throw new Fail('missing', from);
    }

    const doc = applyHunks(readDoc(tree.get(from)!), sec.hunks, from, strict);
    const text = writeDoc(doc);
    if (to === from) {
      tree.now.set(from, text);
    } else {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push({ old: from, new: to });
    }
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;

    // The path is the nearest line before SEARCH, after the previous block, that is not blank or a code fence.
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);

    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);

    const old = lines.slice(searchAt + 1, eq);
    const next = lines.slice(eq + 1, rep);
    const p = path;

    edits.push((tree: Tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, next.length === 0 ? '' : next.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = readDoc(before);
      const found = firstTier(doc.lines, old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const out = splice(doc.lines, at, next.map((t) => ({ k: 'new' as const, t })), found.tier, old);
      tree.now.set(p, writeDoc({ lines: out, br: doc.br, final: doc.final }));
    });

    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;

  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }

    if (l.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: l.slice(14).trim(), moveTo: null, lines: [], chunks: [] };
      i += 1;
      while (i < last && !lines[i]!.startsWith('*** ')) {
        const b = lines[i]!;
        if (b === '') sec.lines.push('');
        else if (b.startsWith('+')) sec.lines.push(b.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
      sections.push(sec);
      continue;
    }

    if (l.startsWith('*** Delete File: ')) {
      const sec: VSection = { kind: 'del', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [] };
      i += 1;
      while (i < last && isBlank(lines[i]!)) i += 1;
      if (i < last && !lines[i]!.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
      sections.push(sec);
      continue;
    }

    if (l.startsWith('*** Update File: ')) {
      const at = i;
      const sec: VSection = { kind: 'upd', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [] };
      i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }

      let cur: Chunk | null = null;
      let eofPending = false;
      const flush = (): void => {
        if (cur === null) return;
        cur.eof = eofPending;
        eofPending = false;
        // Blank lines at the end of a section are not part of it.
        while (cur.body.length > 0) {
          const t = cur.body[cur.body.length - 1]!;
          if (t.k === 'ctx' && t.t === '') cur.body.pop();
          else break;
        }
        sec.chunks.push(cur);
        cur = null;
      };

      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** End of File')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          eofPending = true;
          i += 1;
          flush();
          continue;
        }
        if (b.startsWith('*** Move to: ')) {
          flush();
          sec.moveTo = b.slice(13).trim();
          i += 1;
          continue;
        }
        if (b.startsWith('*** ')) break;
        if (b.startsWith('@@')) {
          flush();
          const text = b.slice(2).trim();
          cur = { anchor: text === '' ? null : text, body: [], eof: false };
          i += 1;
          continue;
        }
        if (b === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push({ k: 'ctx', t: '' });
          i += 1;
          continue;
        }
        const c = b[0];
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push({ k: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', t: b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${at + 1}`);
      sections.push(sec);
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }

    if (sec.kind === 'del') {
      const p = sec.path;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const from = sec.path;
    if (!isSafe(from)) throw new Fail('unsafe', from);
    const to = sec.moveTo;
    if (to !== null && !isSafe(to)) throw new Fail('unsafe', to);

    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);

    const doc = readDoc(before);
    let cur = doc.lines.slice();
    let cursor = 0;

    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        const topTier = strict ? 0 : 2;
        for (let tier = 0; tier <= topTier && found < 0; tier += 1) {
          for (let k = cursor; k < cur.length; k += 1) {
            if (norm(tier, cur[k]!) === norm(tier, chunk.anchor)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', from);
        cursor = found + 1;
      }

      const old = oldLines(chunk.body);
      let at: number;
      let tier = 0;
      if (old.length > 0) {
        let hit = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && hit < 0; t += 1) {
          for (const p of occurrences(cur, old, t, cursor)) {
            if (chunk.eof && p + old.length !== cur.length) continue;
            hit = p;
            tier = t;
            break;
          }
        }
        if (hit < 0) throw new Fail('no-match', from);
        at = hit;
      } else {
        at = chunk.eof ? cur.length : cursor;
      }

      cur = splice(cur, at, chunk.body, tier, old);
      cursor = at + newCount(chunk.body);
    }

    const text = writeDoc({ lines: cur, br: doc.br, final: doc.final });
    if (to === null) {
      tree.now.set(from, text);
    } else {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push({ old: from, new: to });
    }
  });
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const mustExist = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    return text;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = lf(before);
      const target = lf(oldStr);
      const hits: number[] = [];
      for (let k = text.indexOf(target); k >= 0; k = text.indexOf(target, k + 1)) hits.push(k);
      if (hits.length === 0) throw new Fail('no-match', p);
      if (hits.length > 1) throw new Fail('ambiguous', p);
      const at = hits[0]!;
      const out = text.slice(0, at) + lf(newStr) + text.slice(at + target.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const doc = readDoc(mustExist(tree));
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const out = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, writeDoc({ lines: out, br: doc.br, final: doc.final }));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];

  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }

  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l) as unknown);
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function runPatch(args: string[]): { code: number; out: string[] } {
  let fmt: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && fmt === null && FORMATS.includes(a.slice(9))) fmt = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = fmt === null || fmt === 'auto' ? detect(lines) : fmt;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = unifiedEdits(lines, strict);
  } catch (err) {
    if (err instanceof Exit2) return { code: 2, out: [err.line] };
    throw err;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(err);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  // A move that landed replaces its pair's D and A lines and sorts by the new path.
  const rows: Row[] = [];
  const paired = new Set<string>();
  for (const mv of tree.moves) {
    if (paired.has(mv.old) || paired.has(mv.new)) continue;
    if (tree.original(mv.old) === null) continue;
    if (tree.now.get(mv.old) !== null) continue;
    if (tree.original(mv.new) !== null) continue;
    if (tree.now.get(mv.new) === null) continue;
    rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
    paired.add(mv.old);
    paired.add(mv.new);
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const is = tree.now.get(p)!;
    if (was === is) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));

  if (!check) {
    for (const p of tree.now.keys()) {
      if (paired.has(p)) continue;
      const is = tree.now.get(p)!;
      if (is === null) {
        if (tree.original(p) !== null) rmSync(p, { force: true });
      } else if (tree.original(p) !== is) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is);
      }
    }
    for (const mv of tree.moves) {
      if (!paired.has(mv.old)) continue;
      const text = tree.now.get(mv.new);
      if (typeof text !== 'string') continue;
      rmSync(mv.old, { force: true });
      mkdirSync(dirname(mv.new), { recursive: true });
      writeFileSync(mv.new, text);
    }
  }

  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runPatch(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
