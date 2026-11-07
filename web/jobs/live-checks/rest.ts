/**
 * The two reads the live checks need from the database
 * (issue 42-h3-live-check-tools).
 *
 * Plain `fetch` against the Supabase REST API with the SERVICE-ROLE key, the
 * same pattern and the same lazy env as `src/lib/split/supabase-split-store.ts`
 * and `src/lib/split/env.ts`.
 *
 * WHY THE SERVICE ROLE. The ground truth is six proofread past papers, and a
 * question's `correct_idx` and `teacher_explanation` had their column
 * privileges revoked from `anon` and `authenticated` (issues 30 and 36). Only
 * `service_role` can still select them off the table, and the explanation
 * prompt needs the key. These are READS ONLY: neither function writes
 * anything, ever.
 *
 * LAPTOP ONLY, like every other service-role file. Nothing under `src/`
 * imports it; the only importers are the two scripts beside it.
 *
 * Security: the key goes in headers, never a URL. Errors carry the HTTP
 * status and nothing else, because a PostgREST error body quotes the request.
 */
import type { QuestionForExplain } from '@/lib/ai/types';
import type { CheckQuestion } from '@/lib/live-checks/core';
import { readOptions } from '@/lib/questions/types';
import { readServiceEnv, type ServiceEnv } from '@/lib/split/env';

const QUESTIONS = '/rest/v1/questions';

export interface RestOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** The env, or a thrown one-liner. Read INSIDE the call: lazy (CLAUDE.md). */
function required(options: RestOptions): ServiceEnv {
  const found = readServiceEnv(options.env ?? process.env);
  if (!found) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set');
  }
  return found;
}

/** The key in both headers, as PostgREST wants it. */
function headers(found: ServiceEnv): Record<string, string> {
  return {
    apikey: found.serviceRoleKey,
    authorization: 'Bearer ' + found.serviceRoleKey,
    accept: 'application/json',
  };
}

async function getRows(url: string, found: ServiceEnv, doFetch: typeof fetch): Promise<unknown[]> {
  const res = await doFetch(url, { method: 'GET', headers: headers(found), cache: 'no-store' });
  // The status only. A PostgREST error body quotes the request.
  if (!res.ok) throw new Error('database read failed with status ' + res.status);
  const rows = (await res.json()) as unknown;
  return Array.isArray(rows) ? rows : [];
}

/**
 * THE GROUND TRUTH: every question the database holds for one paper.
 *
 * In `number` order, which is the order the paper prints, so the comparison
 * can match the splitter's output by position.
 */
export async function readPaperQuestions(
  paperId: string,
  options: RestOptions = {},
): Promise<CheckQuestion[]> {
  const found = required(options);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  const rows = await getRows(
    `${found.url}${QUESTIONS}?select=number,stem,options&paper_id=eq.${encodeURIComponent(paperId)}` +
      '&order=number.asc&limit=200',
    found,
    doFetch,
  );

  const out: CheckQuestion[] = [];
  for (const raw of rows) {
    const row = raw as { number?: unknown; stem?: unknown; options?: unknown };
    const number = typeof row.number === 'number' ? row.number : Number(row.number);
    const stem = typeof row.stem === 'string' ? row.stem : '';
    const opts = readOptions(row.options);
    // A row we cannot read is DROPPED, never guessed at: a guessed ground
    // truth would make the accuracy number a lie.
    if (!Number.isInteger(number) || stem.trim().length === 0 || !opts) continue;
    out.push({ number, stem, options: opts });
  }
  return out;
}

/**
 * One question, in the shape the explanation prompt takes.
 *
 * The same select the app makes (`supabase-ai-client.question()`), plus the
 * two columns the app has to fetch through `question_keys()` and
 * `question_explanations()` because its token is `authenticated`. Our key is
 * the service role, so one request is enough and the prompt it builds is
 * character for character the prompt the app builds.
 */
export async function readQuestionForExplain(
  questionId: string,
  options: RestOptions = {},
): Promise<QuestionForExplain | null> {
  const found = required(options);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  const rows = await getRows(
    `${found.url}${QUESTIONS}?select=stem,options,correct_idx,teacher_explanation,` +
      `papers(exams(name_en))&id=eq.${encodeURIComponent(questionId)}`,
    found,
    doFetch,
  );
  if (rows.length === 0) return null;

  const row = rows[0] as {
    stem?: unknown;
    options?: unknown;
    correct_idx?: unknown;
    teacher_explanation?: unknown;
    papers?: unknown;
  };

  const stem = typeof row.stem === 'string' ? row.stem.trim() : '';
  const opts = readOptions(row.options);
  const correctIdx = typeof row.correct_idx === 'number' ? row.correct_idx : Number(row.correct_idx);
  if (stem.length === 0 || !opts) return null;
  // No key means no explanation, exactly as the app decides it: an
  // explanation of a question whose right answer we do not know is a guess.
  if (!Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx > 3) return null;

  return {
    exam: readExamName(row.papers),
    // The app sends null here too: the topic NAME is a later slice and a uuid
    // is not worth showing the model.
    topic: null,
    stem,
    options: opts,
    correctIdx,
    teacherExplanation:
      typeof row.teacher_explanation === 'string' && row.teacher_explanation.trim().length > 0
        ? row.teacher_explanation.trim()
        : null,
  };
}

/** `papers(exams(name_en))` is an object or an array, depending on the join. */
function readExamName(value: unknown): string | null {
  const paper = Array.isArray(value) ? value[0] : value;
  if (typeof paper !== 'object' || paper === null) return null;
  const exams = (paper as { exams?: unknown }).exams;
  const exam = Array.isArray(exams) ? exams[0] : exams;
  if (typeof exam !== 'object' || exam === null) return null;
  const name = (exam as { name_en?: unknown }).name_en;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}
