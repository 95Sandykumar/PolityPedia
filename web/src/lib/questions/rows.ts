/**
 * Postgres row -> app object, for `ingest_jobs` and `questions`
 * (issue 11-ingest-job-review-publish).
 *
 * Its own file because TWO transports read the same rows: the REST client
 * (`supabase-questions-client.ts`) and the Realtime socket
 * (`supabase-live.ts`). One reader means a column renamed later cannot be
 * mapped correctly in one place and wrongly in the other.
 *
 * Every reader FAILS CLOSED. A row whose `status` we do not recognise is
 * dropped rather than guessed at, because an unknown status could mean `live`
 * one day and a draft question must never be shown to a student by accident
 * (Risk 1).
 */
import {
  isIngestJobStatus,
  isQuestionStatus,
  readOptions,
  type IngestJob,
  type Question,
} from './types';

/** Never `select=*`, so a column added later cannot leak by accident. */
export const JOB_COLUMNS =
  'id,teacher_id,paper_id,pdf_path,status,attempts,error,question_count';

export const QUESTION_COLUMNS =
  'id,teacher_id,paper_id,test_id,number,stem,options,correct_idx,' +
  'teacher_explanation,topic_id,lang,image_path,checked,status';

export interface JobRow {
  id?: unknown;
  teacher_id?: unknown;
  paper_id?: unknown;
  pdf_path?: unknown;
  status?: unknown;
  attempts?: unknown;
  error?: unknown;
  question_count?: unknown;
}

export interface QuestionRow {
  id?: unknown;
  teacher_id?: unknown;
  paper_id?: unknown;
  test_id?: unknown;
  number?: unknown;
  stem?: unknown;
  options?: unknown;
  correct_idx?: unknown;
  teacher_explanation?: unknown;
  topic_id?: unknown;
  lang?: unknown;
  image_path?: unknown;
  checked?: unknown;
  status?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function whole(value: unknown, fallback: number | null = null): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // Realtime sends every column as a string in some payload versions, and
  // PostgREST returns bigints as text, so a numeric string is accepted too.
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return fallback;
}

/** One `ingest_jobs` row, or null when it is not the shape we expect. */
export function readJobRow(raw: JobRow | null | undefined): IngestJob | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = text(raw.id);
  const teacherId = text(raw.teacher_id);
  const paperId = text(raw.paper_id);
  const pdfPath = text(raw.pdf_path);
  if (!id || !teacherId || !paperId || !pdfPath) return null;
  if (!isIngestJobStatus(raw.status)) return null;

  return {
    id,
    teacherId,
    paperId,
    pdfPath,
    status: raw.status,
    attempts: whole(raw.attempts, 0) ?? 0,
    error: text(raw.error),
    questionCount: whole(raw.question_count, 0) ?? 0,
  };
}

/** One `questions` row, or null. */
export function readQuestionRow(raw: QuestionRow | null | undefined): Question | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = text(raw.id);
  const teacherId = text(raw.teacher_id);
  const stem = text(raw.stem);
  if (!id || !teacherId || !stem) return null;

  const number = whole(raw.number);
  const correctIdx = whole(raw.correct_idx);
  if (number === null || correctIdx === null) return null;
  if (correctIdx < 0 || correctIdx > 3) return null;

  // Realtime can hand over a jsonb column as its JSON TEXT, so parse first.
  let rawOptions = raw.options;
  if (typeof rawOptions === 'string') {
    try {
      rawOptions = JSON.parse(rawOptions) as unknown;
    } catch {
      return null;
    }
  }
  const options = readOptions(rawOptions);
  if (!options) return null;

  if (!isQuestionStatus(raw.status)) return null;
  const lang = raw.lang === 'hi' ? 'hi' : 'en';

  return {
    id,
    teacherId,
    paperId: text(raw.paper_id),
    testId: text(raw.test_id),
    number,
    stem,
    options,
    correctIdx,
    teacherExplanation: text(raw.teacher_explanation),
    topicId: text(raw.topic_id),
    lang,
    imagePath: text(raw.image_path),
    // Fails closed: anything that is not exactly `true` is unchecked.
    checked: raw.checked === true || raw.checked === 'true',
    status: raw.status,
  };
}
