/**
 * The split-job and questions contract (issue 11-ingest-job-review-publish).
 *
 * V9: the AI splits a paper PDF into questions, the teacher checks each one
 * next to its PDF page, then publishes. NOTHING IS LIVE BEFORE PUBLISH, and
 * Risk 1 in design.md is the reason: a wrong answer out of the split must not
 * reach a student first.
 *
 * Every outside service sits behind one of the small interfaces at the bottom
 * of this file, so the tests fake it: no real network call and no real key
 * anywhere in the suite (web/CLAUDE.md).
 *
 *  * `QuestionsClient`  -- server side, carries the caller's own access token,
 *                          so Postgres RLS (`questions_*`) is the real gate.
 *  * `IngestJobsClient` -- the same for `ingest_jobs`.
 *  * `Live`             -- Supabase Realtime in production, a fake in tests.
 *                          B6: the job status is PUSHED, never polled.
 *  * `BrowserQuestionsClient` -- posts to our own route and sees no key.
 *
 * The validation here is a COPY of the SQL constraints in 0011, on purpose.
 * The database is the gate; this is so the teacher gets an answer without a
 * round trip, and so a bad shape never reaches the REST call.
 */
import type { Lang } from '@/lib/i18n';

/** Four options, A to D. Three or five is not a question, it is a bad split. */
export const OPTION_COUNT = 4;

/** F-D2: 200 questions per PDF. Same number as `questions_number_check`. */
export const MAX_QUESTIONS_PER_PAPER = 200;

/** Long enough for a comprehension stem, short enough to refuse a whole PDF. */
export const MAX_STEM_LENGTH = 2000;
export const MAX_OPTION_LENGTH = 500;
export const MAX_EXPLANATION_LENGTH = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The teacher's review screen for one paper. A page path, not an API one: the
 * Papers list links to it, and `papers-list.tsx` must not have to know how
 * this slice spells its route.
 */
export function paperReviewPath(paperId: string): string {
  return `/teacher/papers/${encodeURIComponent(paperId)}/review`;
}

// --------------------------------------------------------------------------
// The split job
// --------------------------------------------------------------------------

export type IngestJobStatus = 'queued' | 'running' | 'done' | 'failed';

export const INGEST_JOB_STATUSES: readonly IngestJobStatus[] = [
  'queued',
  'running',
  'done',
  'failed',
];

export function isIngestJobStatus(value: unknown): value is IngestJobStatus {
  return (
    typeof value === 'string' && (INGEST_JOB_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * True while questions may still arrive. `failed` is NOT busy: the split is
 * over, and the teacher can still type the questions by hand, so blocking
 * Publish on a failed job would leave them stuck.
 */
export function isJobBusy(status: IngestJobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** One row of `ingest_jobs`. The review screen watches it over `Live`. */
export interface IngestJob {
  id: string;
  teacherId: string;
  paperId: string;
  /** Object path of the PDF inside the `papers` bucket. */
  pdfPath: string;
  status: IngestJobStatus;
  /** 0 to 3. design.md: 3 retries, then `failed`. */
  attempts: number;
  /** Why it failed, shown to the teacher as-is. Null while it is fine. */
  error: string | null;
  /** How many questions the split has produced so far. */
  questionCount: number;
}

// --------------------------------------------------------------------------
// The question
// --------------------------------------------------------------------------

export type QuestionStatus = 'draft' | 'live';

export function isQuestionStatus(value: unknown): value is QuestionStatus {
  return value === 'draft' || value === 'live';
}

/** Exactly four options, in A B C D order. */
export type QuestionOptions = [string, string, string, string];

/**
 * Four filled-in strings, trimmed, or null.
 *
 * The same rule as `questions_options_check` in 0011. Trimming here means a
 * stray space out of the PDF never becomes part of a stored answer.
 */
export function readOptions(value: unknown): QuestionOptions | null {
  if (!Array.isArray(value) || value.length !== OPTION_COUNT) return null;

  const out: string[] = [];
  for (const one of value) {
    if (typeof one !== 'string') return null;
    const trimmed = one.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_OPTION_LENGTH) return null;
    out.push(trimmed);
  }
  return [out[0], out[1], out[2], out[3]];
}

/** One row of `questions`, as the app passes it around. */
export interface Question {
  id: string;
  teacherId: string;
  /** Set for a past-paper question. Null for a mock-test one (issue 15). */
  paperId: string | null;
  testId: string | null;
  number: number;
  stem: string;
  options: QuestionOptions;
  /**
   * 0 to 3, an index into `options`. Never a letter.
   *
   * NULL WHEN THE CALLER WAS NOT GIVEN THE KEY (issue 30-exam-key-lock). The
   * column is not readable off the table any more, so a question arrives
   * key-less and the key is merged in from `question_keys()` only when
   * Postgres hands one over. That is F-E5 as a TYPE: an exam question cannot
   * accidentally carry a right answer, because there is nothing to carry.
   */
  correctIdx: number | null;
  teacherExplanation: string | null;
  topicId: string | null;
  lang: Lang;
  imagePath: string | null;
  /** The teacher has read it next to its PDF page and is happy with it. */
  checked: boolean;
  status: QuestionStatus;
}

/**
 * One question on its way from the review form to the server.
 *
 * `id` is null for a question the teacher added by hand. There is no
 * `teacherId` and no `status`: the owner comes from the session cookie and the
 * status only ever changes through `publish_paper()` or
 * `publish_mock_set()`.
 *
 * EXACTLY ONE PARENT, the same XOR as `questions_one_parent_check`: a
 * past-paper question hangs on a paper, a mock-test question on a test
 * (issue 15-mock-sets-authoring).
 */
export interface QuestionEdit {
  id: string | null;
  /** Set for a past-paper question, null for a mock-test one. */
  paperId: string | null;
  /** Set for a mock-test question, null for a past-paper one. */
  testId: string | null;
  number: number;
  stem: string;
  options: QuestionOptions;
  correctIdx: number;
  teacherExplanation: string | null;
  lang: Lang;
  checked: boolean;
}

function readLang(value: unknown): Lang | null {
  // `both` is a display MODE, never a stored question language: a question is
  // written in one language.
  return value === 'en' || value === 'hi' ? value : null;
}

/**
 * One parent id out of a body: the uuid, `null` when it was not sent, or
 * `'bad'` when something was sent that is not a uuid.
 *
 * The three answers matter. "Not sent" is normal (a mock-test question sends
 * no `paperId`), while "sent and wrong" is a bug or an attack and has to be
 * refused outright rather than read as "not sent", which would let
 * `{ paperId: '../../etc', testId: <valid> }` through as a test question.
 */
function readParentId(value: unknown): string | null | 'bad' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) return 'bad';
  return value;
}

/**
 * Validate anything into a `QuestionEdit`, or null.
 *
 * Only the ten fields above are carried over, so a `status: 'live'` or a
 * `teacherId` in the body is dropped right here rather than being refused: a
 * caller who sends it gets a stored draft, not a hint about what we check.
 *
 * EXACTLY ONE of `paperId` and `testId`. Both, or neither, is refused here and
 * would be refused again by `questions_one_parent_check` in Postgres.
 */
export function readQuestionEdit(body: unknown): QuestionEdit | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  // Null or missing = a new question. Anything else must be a real uuid,
  // because it goes into a URL.
  let id: string | null = null;
  if (raw.id !== null && raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return null;
    id = raw.id;
  }

  const paperId = readParentId(raw.paperId);
  const testId = readParentId(raw.testId);
  if (paperId === 'bad' || testId === 'bad') return null;
  // `===` on two booleans is XNOR: true when BOTH are null or NEITHER is, and
  // both of those are a question with the wrong number of parents.
  if ((paperId === null) === (testId === null)) return null;

  if (typeof raw.number !== 'number' || !Number.isInteger(raw.number)) return null;
  if (raw.number < 1 || raw.number > MAX_QUESTIONS_PER_PAPER) return null;

  if (typeof raw.stem !== 'string') return null;
  const stem = raw.stem.trim();
  if (stem.length === 0 || stem.length > MAX_STEM_LENGTH) return null;

  const options = readOptions(raw.options);
  if (!options) return null;

  if (typeof raw.correctIdx !== 'number' || !Number.isInteger(raw.correctIdx)) return null;
  if (raw.correctIdx < 0 || raw.correctIdx >= OPTION_COUNT) return null;

  const lang = readLang(raw.lang);
  if (!lang) return null;

  let teacherExplanation: string | null = null;
  if (typeof raw.teacherExplanation === 'string') {
    const trimmed = raw.teacherExplanation.trim();
    if (trimmed.length > MAX_EXPLANATION_LENGTH) return null;
    // Blank becomes NULL, never an empty string: "no explanation" is one value.
    teacherExplanation = trimmed.length > 0 ? trimmed : null;
  } else if (raw.teacherExplanation !== null && raw.teacherExplanation !== undefined) {
    return null;
  }

  return {
    id,
    paperId,
    testId,
    number: raw.number,
    stem,
    options,
    correctIdx: raw.correctIdx,
    teacherExplanation,
    lang,
    // Fails CLOSED: anything that is not exactly `true` leaves the question
    // unchecked, so a half-written body can never check a question.
    checked: raw.checked === true,
  };
}

// --------------------------------------------------------------------------
// The publish gate
// --------------------------------------------------------------------------

/** Why Publish is off, or null when it is on. */
export type PublishBlock = 'splitting' | 'unchecked' | null;

/**
 * The same two refusals `publish_paper()` raises, so the button and the
 * database never disagree. The database is still the gate: this only decides
 * whether the button is greyed out.
 *
 * The split is reported FIRST, because it is the reason that clears itself:
 * telling a teacher about unchecked questions while they are still arriving
 * would be noise.
 */
export function publishBlock({
  job,
  questions,
}: {
  job: IngestJob | null;
  questions: readonly Question[];
}): PublishBlock {
  if (job && isJobBusy(job.status)) return 'splitting';
  if (questions.some((one) => !one.checked)) return 'unchecked';
  return null;
}

/**
 * The number for a question the teacher adds by hand: one past the highest one
 * already there, not the count, so a gap in the split does not cause a clash
 * with `questions_paper_number_idx`.
 */
export function nextQuestionNumber(questions: readonly Question[]): number {
  let highest = 0;
  for (const one of questions) if (one.number > highest) highest = one.number;
  return Math.min(highest + 1, MAX_QUESTIONS_PER_PAPER);
}

/** Questions in paper order. The review screen walks them one by one. */
export function sortQuestions(questions: readonly Question[]): Question[] {
  return [...questions].sort((a, b) => a.number - b.number);
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** What a question read wants beyond the ids (issue 30-exam-key-lock). */
export interface QuestionReadOptions {
  /**
   * Ask `question_keys()` for the answer key AND `question_explanations()`
   * for the teacher's prose, and merge both in (issues 30-exam-key-lock and
   * 36-exam-leaks-close).
   *
   * ONE flag for both, because Postgres refuses both through the same gate
   * for the same reason: the prose names the right option in words, so it is
   * answer key material too.
   *
   * Default false. A reader that does not need them must not ask: asking is
   * what gets REFUSED mid-exam, and key material that was never fetched
   * cannot be shipped to a phone by a later bug.
   */
  keys?: boolean;
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface QuestionsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * One paper's questions, in number order. Drafts included, for the owner.
   *
   * `options.keys` asks for the ANSWER KEY as well (issue 30-exam-key-lock).
   * It costs a second request to `question_keys()` and it can be REFUSED, so
   * it is opt-in: a caller that does not say so gets `correctIdx: null` and
   * can never leak a key it never held.
   */
  listForPaper(paperId: string, options?: QuestionReadOptions): Promise<Question[]>;
  /**
   * One mock test's questions, in number order
   * (issue 15-mock-sets-authoring).
   *
   * OPTIONAL, so a caller that only deals with past papers (and every fake
   * written for issue 11) is still a whole `QuestionsClient`. Call it as
   * `client.listForTest?.(id) ?? []`.
   *
   * `topicId` is F-E4's topic filter (issue 17-practice-mode): one topic
   * instead of the full paper. The filter is applied by POSTGRES, not after
   * the read, so "one topic" is one small request and not the whole paper
   * thrown away in the browser. Null or missing means the full paper.
   */
  listForTest?(
    testId: string,
    topicId?: string | null,
    options?: QuestionReadOptions,
  ): Promise<Question[]>;
  /**
   * `question_keys()`: the answer key for questions the caller has already
   * read, and the only route to it since `0030_exam_key_lock.sql` took the
   * column privilege away (issue 30-exam-key-lock).
   *
   * Returns question id -> key, with any question the caller may not have
   * simply missing. THROWS an error named `ExamKeyLocked` while the caller
   * has an open exam sitting for that test, which is the one refusal the UI
   * has to put into words (F-E5).
   *
   * OPTIONAL, so every fake written before this issue is still a whole
   * `QuestionsClient`.
   */
  readKeys?(questionIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * `question_explanations()`: the teacher's prose explanation for questions
   * the caller has already read, and the only route to it since
   * `0037_exam_leaks_close.sql` took the column privilege away
   * (issue 36-exam-leaks-close).
   *
   * The twin of `readKeys`: question id -> prose, with any question the
   * caller may not have (or that has no explanation stored) simply missing,
   * and the same `ExamKeyLocked` error while an exam sitting of that test is
   * open. The prose says which option is right in words, which is why it
   * travels the same way the key does.
   *
   * OPTIONAL, so every fake written before this issue is still a whole
   * `QuestionsClient`.
   */
  readExplanations?(questionIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Store one question. The owner is the session user, never a field of the
   * input, and the row is always a DRAFT. Throws an error named
   * `QuestionConflict` when that number is taken.
   */
  save(edit: QuestionEdit): Promise<Question>;
  /**
   * `publish_paper()`. Returns how many questions went live. Throws an error
   * named `PublishSplitting`, `PublishUnchecked` or `PublishForbidden`.
   */
  publishPaper(paperId: string): Promise<number>;
}

/** Server side, for `ingest_jobs`. */
export interface IngestJobsClient {
  isConfigured(): boolean;
  /** Queue one PDF for the splitter. Called by the upload route (issue 10). */
  createQueued(input: { paperId: string; pdfPath: string }): Promise<IngestJob>;
  /** The newest job for one paper, or null when the PDF was never queued. */
  readLatestForPaper(paperId: string): Promise<IngestJob | null>;
}

/**
 * A pushed stream of one row.
 *
 * Supabase Realtime in production, a fake in tests. B6: the job status is
 * pushed, so the review screen has no timer in it. The 5-minute sweep in
 * design.md is the WORKER's fallback, not this screen's.
 */
export interface Live {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /**
   * Watch one `ingest_jobs` row. Returns the function that stops watching;
   * calling it twice is safe.
   */
  watchJob(jobId: string, onChange: (job: IngestJob) => void): () => void;
}

/** Browser side: the review screen. Calls our own routes, holds no key. */
export interface BrowserQuestionsClient {
  save(edit: QuestionEdit): Promise<Question>;
  /** Returns how many questions went live. */
  publish(paperId: string): Promise<number>;
}
