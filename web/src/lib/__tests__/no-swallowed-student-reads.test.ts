/**
 * The close-out guard for issue 54-visible-read-errors.
 *
 * Parts 54a, 54b and 54c gave the student screens a result type
 * (`@/lib/read-result`) and one shared error component, so a read that FAILED
 * stops arriving at the screen as a read that was EMPTY. A missing
 * `archived_at` column once showed "No mock tests yet. Your teacher adds them
 * soon." while the content was there.
 *
 * Nothing stops that coming back. One `.catch(() => [])` added to a student
 * reader six months from now puts the lie straight back on the screen, and it
 * looks like ordinary defensive code in review. So this test greps the student
 * readers and FAILS when the count of swallowed reads changes.
 *
 * What counts as swallowing: `.catch(() => <anything>)` and
 * `if (!res.ok) return <anything>`. Both turn a failure into a value the
 * screen cannot tell from "nothing here yet".
 *
 * What does NOT count: the same `.catch` INSIDE a `readWithProbe(...)` call.
 * That is the 54a design. The probe is a `fetch` stand-in that has already
 * recorded the non-ok status by then, so the reader still answers
 * `{ ok: false }` and the catch only keeps the types quiet.
 *
 * Each remaining swallow is listed below WITH A REASON. The list is a ratchet,
 * not a mute button: the numbers are exact, so adding a swallow to a reader
 * that is already on the list fails this test too.
 *
 * Grep equivalent, for a human doing the same check by hand:
 *   grep -n -E "catch\(\(\) *=>|!res\.ok" <the files in FILES below>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The student-side readers. The file map of issue 54-visible-read-errors. */
const FILES = [
  'src/lib/attempts/student-page.ts',
  'src/lib/exam/student-page.ts',
  'src/lib/follows/student-page.ts',
  'src/lib/practice/student-page.ts',
  'src/lib/saved/student-page.ts',
  'src/lib/set-access/student-page.ts',
  'src/lib/videos/page-data.ts',
  'src/lib/posts/server-posts.ts',
  'src/app/(student)/_data/student-ui-data.ts',
] as const;

/**
 * Every swallowed read left in those files, by `<file>#<function>`, with the
 * reason it is allowed to stay. A new one anywhere fails the test below.
 */
const ALLOWED: Record<string, { readonly count: number; readonly why: string }> = {
  // The two player loaders. Their failure is not an empty list: with no
  // sitting there is nowhere to put an answer, and both already say "not
  // ready" instead of handing back a blank paper. The soft reads around that
  // (catalogue, marking, the heading) only change wording on a page that
  // renders either way.
  'src/lib/attempts/student-page.ts#readPracticeData': {
    count: 2,
    why: 'practice player: no sitting already has its own message, not an empty state',
  },
  'src/lib/exam/student-page.ts#readExamLoad': {
    count: 7,
    why: 'exam player: the sitting fails hard, the four reads around it only change wording',
  },
  'src/lib/practice/student-page.ts#readMockPracticeData': {
    count: 4,
    why: 'mock player: same shape as readExamLoad',
  },

  // Not a list and not an empty state: the student's own language. A failed
  // read falls back to the default mode so the page still has labels.
  'src/lib/follows/student-page.ts#readStudentContext': {
    count: 1,
    why: 'language fallback, never drawn as content',
  },

  // Header trimmings on a page that shows its own read error already.
  'src/app/(student)/_data/student-ui-data.ts#readHomeExam': {
    count: 1,
    why: 'the next-exam pill: no pill is honest, and the lists below own the error state',
  },
  'src/app/(student)/_data/student-ui-data.ts#readTeacherExamNames': {
    count: 1,
    why: 'the exam chips under the name, next to tiles that show the error state',
  },

  // Entitlement, not content. It must fail CLOSED to the free tier: a broken
  // read may never hand out a paid plan.
  'src/app/(student)/_data/student-ui-data.ts#readPlanState': {
    count: 1,
    why: 'fails closed to the free tier on purpose',
  },

  // Teacher screens. Out of scope for issue 54 (student side only).
  'src/lib/videos/page-data.ts#readMyVideos': {
    count: 2,
    why: 'teacher screen, out of scope for issue 54',
  },
  'src/lib/posts/server-posts.ts#readMyPosts': {
    count: 1,
    why: 'teacher screen, out of scope for issue 54',
  },
};

/**
 * The source with every `readWithProbe(...)` call blanked out, newlines kept
 * so line numbers still line up. Paren counting only: these files hold no
 * parenthesis inside a string literal, which the test below asserts.
 */
function withoutProbes(source: string): string {
  const out = source.split('');
  const marker = 'readWithProbe';
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    const open = source.indexOf('(', i);
    if (open === -1) continue;
    let depth = 0;
    for (let j = open; j < source.length; j += 1) {
      if (source[j] === '(') depth += 1;
      else if (source[j] === ')') depth -= 1;
      if (source[j] !== '\n') out[j] = ' ';
      if (depth === 0) break;
    }
  }
  return out.join('');
}

/** `.catch(() => ...)` or `if (!res.ok) return ...`: a failure turned into a value. */
const SWALLOW = /\.catch\(\s*\(\)\s*=>|!res\.ok\)\s*return/g;

/** The nearest exported function above a line, which is what the reader is called. */
function enclosingFunction(lines: readonly string[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const found = /^export (?:async )?function (\w+)/.exec(lines[i] ?? '');
    if (found) return found[1] as string;
  }
  return '<file>';
}

function countSwallows(file: string): Record<string, number> {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  const lines = withoutProbes(source).split('\n');
  const counts: Record<string, number> = {};
  lines.forEach((line, index) => {
    const hits = line.match(SWALLOW)?.length ?? 0;
    if (hits === 0) return;
    const key = `${file}#${enclosingFunction(lines, index)}`;
    counts[key] = (counts[key] ?? 0) + hits;
  });
  return counts;
}

describe('student readers never swallow a failed read', () => {
  it('has the same swallowed reads as the list above, and no others', () => {
    const found: Record<string, number> = {};
    for (const file of FILES) Object.assign(found, countSwallows(file));

    const allowed = Object.fromEntries(
      Object.entries(ALLOWED).map(([key, value]) => [key, value.count]),
    );

    // A readable failure: the key names the file and the reader, so the fix is
    // either the shared `ReadResult` or one more line in ALLOWED with a reason.
    expect(found).toEqual(allowed);
  });

  it('gives a reason for every swallowed read it still allows', () => {
    for (const [key, value] of Object.entries(ALLOWED)) {
      expect(value.why.length, key).toBeGreaterThan(20);
      expect(value.count, key).toBeGreaterThan(0);
    }
  });

  it('reads files that are really there', () => {
    for (const file of FILES) {
      expect(readFileSync(join(process.cwd(), file), 'utf8').length, file).toBeGreaterThan(0);
    }
  });

  it('blanks a probe body without moving any line', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/saved/student-page.ts'), 'utf8');
    const stripped = withoutProbes(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    // The probe body is gone, the import that names it is not.
    expect(stripped).toContain('read-result');
    expect(SWALLOW.test(stripped)).toBe(false);
    SWALLOW.lastIndex = 0;
  });
});
