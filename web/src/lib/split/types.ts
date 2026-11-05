/**
 * The PDF split contract (issue 12-pdf-split-worker, design.md P9).
 *
 * A teacher uploads a paper, issue 11 writes a `queued` row in `ingest_jobs`,
 * and the worker in `web/jobs/pdf-split.ts` picks it up: it loads the PDF,
 * asks Claude Haiku to cut it into questions, and writes the result as
 * UNCHECKED DRAFTS. Nothing here can put a question in front of a student:
 * `questions_live_is_checked_check` in 0011 makes that impossible (Risk 1).
 *
 * Every outside service hides behind one of the four interfaces at the bottom,
 * so the whole worker is tested with fakes: no real network call, no real key
 * and no real PDF anywhere in the suite (web/CLAUDE.md).
 *
 *  * `QuestionSplitter` -- the model. `haiku-splitter.ts` in production,
 *                          `memory-splitter.ts` in tests.
 *  * `SplitStore`       -- `ingest_jobs` + `questions` with the SERVICE ROLE,
 *                          because the worker is not a signed-in user.
 *  * `FileStore`        -- Supabase Storage, reused from issue 10.
 *  * `JobFeed`          -- Realtime inserts, so a waiting teacher is not stuck
 *                          behind the 5-minute sweep (B6).
 *
 * TRUST. `split()` returns `unknown`, not a typed value, on purpose: the
 * model's answer is UNTRUSTED DATA, exactly like the PDF text that produced
 * it. `readSplitAnswer` below is the only door into the rest of the app, and
 * it fails closed.
 */
import type { IngestJob } from '@/lib/questions/types';
import {
  MAX_OPTION_LENGTH,
  MAX_QUESTIONS_PER_PAPER,
  MAX_STEM_LENGTH,
  MAX_EXPLANATION_LENGTH,
  OPTION_COUNT,
  readOptions,
  type QuestionOptions,
} from '@/lib/questions/types';

/** F-D4 / design.md: 3 tries, then `failed` with the reason. */
export const MAX_SPLIT_ATTEMPTS = 3;

/** F-D2: 200 questions per PDF. The 201st is a refusal, not a truncation. */
export { MAX_QUESTIONS_PER_PAPER };

/** The model PRD F6 picks: the cheapest current tier. */
export const SPLIT_MODEL = 'claude-haiku-5-5';

/**
 * One question as the model hands it over: the issue's schema exactly.
 * `explanation` is whatever the PDF itself said, or null.
 */
export interface SplitQuestion {
  stem: string;
  options: QuestionOptions;
  /** 0 to 3, an index into `options`. Never a letter. */
  correctIdx: number;
  explanation: string | null;
}

/**
 * Why a split did not produce questions. A short STABLE CODE, not a sentence,
 * because it is stored in `ingest_jobs.error` and the review screen turns it
 * into English and Hindi (`splitError.*` in i18n). A model's own words are not
 * translatable and could carry anything a PDF told it to say.
 */
export type SplitFailure =
  | 'no-pdf'
  | 'bad-answer'
  | 'no-questions'
  | 'too-many'
  | 'splitter-error'
  | 'write-failed';

export const SPLIT_FAILURES: readonly SplitFailure[] = [
  'no-pdf',
  'bad-answer',
  'no-questions',
  'too-many',
  'splitter-error',
  'write-failed',
];

export function isSplitFailure(value: unknown): value is SplitFailure {
  return typeof value === 'string' && (SPLIT_FAILURES as readonly string[]).includes(value);
}

/**
 * True for a failure that a second try could fix.
 *
 * `too-many`, `no-pdf` and `write-failed` are NOT retryable: the same
 * 201-question PDF gives the same count every time, a deleted object stays
 * deleted, and a rejected row (a clashing question number) is rejected again.
 * Retrying them would spend three model calls to reach the same answer.
 */
export function isRetryable(failure: SplitFailure): boolean {
  return failure === 'bad-answer' || failure === 'no-questions' || failure === 'splitter-error';
}

export type SplitReading =
  | { ok: true; questions: SplitQuestion[] }
  | { ok: false; reason: SplitFailure };

/**
 * The model's answer -> questions, or a reason. The gate for Risk 1.
 *
 * It repeats the SQL constraints of `questions` in 0011 (four filled-in
 * options, a stem, `correct_idx` 0 to 3) so a bad shape never reaches the REST
 * call, and it refuses the WHOLE answer when one question is wrong rather than
 * dropping that one: a silently skipped question is a gap the teacher cannot
 * see, and the retry is cheap.
 */
export function readSplitAnswer(value: unknown): SplitReading {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'bad-answer' };

  const raw = (value as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return { ok: false, reason: 'bad-answer' };

  // Checked BEFORE the per-question work: a 5000-entry answer is refused
  // without validating 5000 stems.
  if (raw.length > MAX_QUESTIONS_PER_PAPER) return { ok: false, reason: 'too-many' };
  if (raw.length === 0) return { ok: false, reason: 'no-questions' };

  const questions: SplitQuestion[] = [];
  for (const one of raw) {
    const question = readSplitQuestion(one);
    if (!question) return { ok: false, reason: 'bad-answer' };
    questions.push(question);
  }
  return { ok: true, questions };
}

/** One question out of the model, or null. Snake case, as the schema asks. */
export function readSplitQuestion(value: unknown): SplitQuestion | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.stem !== 'string') return null;
  const stem = raw.stem.trim();
  if (stem.length === 0 || stem.length > MAX_STEM_LENGTH) return null;

  // Same four-filled-in-strings rule as `questions_options_check`.
  const options = readOptions(raw.options);
  if (!options) return null;

  const correctIdx = raw.correct_idx;
  if (typeof correctIdx !== 'number' || !Number.isInteger(correctIdx)) return null;
  if (correctIdx < 0 || correctIdx >= OPTION_COUNT) return null;

  let explanation: string | null = null;
  if (typeof raw.explanation === 'string') {
    const trimmed = raw.explanation.trim();
    // Too long is TRIMMED, not refused: an over-long explanation is a nuisance
    // the teacher edits, while a refusal costs the whole paper.
    explanation = trimmed.length > 0 ? trimmed.slice(0, MAX_EXPLANATION_LENGTH) : null;
  } else if (raw.explanation !== null && raw.explanation !== undefined) {
    return null;
  }

  return { stem, options, correctIdx, explanation };
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

export interface SplitRequest {
  /** The paper PDF, as bytes. Never a path: the model needs the file. */
  pdf: Uint8Array;
  /** The cap to tell the model about, so it stops instead of inventing. */
  maxQuestions: number;
}

/** The model. One call in, one UNTRUSTED answer out. */
export interface QuestionSplitter {
  /** False when `ANTHROPIC_API_KEY` is missing, so the worker stays idle. */
  isConfigured(): boolean;
  /**
   * The model's answer, UNVALIDATED. Pass it to `readSplitAnswer`; never read
   * a field off it directly. Throws on a transport or API error.
   */
  split(request: SplitRequest): Promise<unknown>;
}

/** One draft row the worker wrote, as the app passes it around. */
export interface SplitDraft {
  id: string;
  jobId: string;
  teacherId: string;
  paperId: string;
  number: number;
  stem: string;
  options: QuestionOptions;
  correctIdx: number;
  teacherExplanation: string | null;
  checked: boolean;
  status: 'draft';
}

/**
 * `ingest_jobs` and `questions` as the WORKER sees them.
 *
 * The worker is not a signed-in user, so this one runs with the service-role
 * key and bypasses RLS. That key never leaves the laptop: no route handler and
 * no browser file imports this interface's Supabase implementation.
 */
export interface SplitStore {
  /** False when the service-role env vars are missing. */
  isConfigured(): boolean;
  /**
   * Take ONE queued job, oldest first, and mark it `running` with
   * `attempts = 1`, in a single atomic statement. Two workers racing get two
   * different jobs, or one gets null.
   */
  claimQueuedJob(): Promise<IngestJob | null>;
  /** Record which try we are on, so the teacher sees "2 of 3". */
  setAttempts(jobId: string, attempts: number): Promise<void>;
  /** D4: a re-run deletes this job's own drafts first. Returns how many. */
  deleteDraftsForJob(jobId: string): Promise<number>;
  /** Write the split output as unchecked drafts. Returns how many landed. */
  insertDrafts(input: {
    job: IngestJob;
    questions: readonly SplitQuestion[];
  }): Promise<number>;
  /** `done` plus the count the review screen shows. */
  finishJob(input: { jobId: string; questionCount: number }): Promise<void>;
  /** `failed` plus the reason the teacher reads. */
  failJob(input: { jobId: string; error: SplitFailure }): Promise<void>;
}

/**
 * "A job just arrived." Supabase Realtime in production, a fake in tests.
 *
 * B6: a teacher watching the review screen must not wait up to 5 minutes for
 * the sweep, so an insert pushes the worker awake. The payload is not used:
 * the worker always re-reads the queue itself, so a dropped or duplicated
 * frame cannot make it work on the wrong row.
 */
export interface JobFeed {
  isConfigured(): boolean;
  /** Returns the function that stops watching. Calling it twice is safe. */
  watchNewJobs(onJob: () => void): () => void;
}

export { MAX_OPTION_LENGTH, MAX_STEM_LENGTH };
