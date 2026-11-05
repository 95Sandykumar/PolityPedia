/**
 * Postgres row -> `Explanation`, for `ai_explanations`
 * (issue 23-revision-screen).
 *
 * Its own file because TWO transports read the same row and BOTH of them run
 * in the browser: the reply body of `/api/revision` and the Realtime push
 * from `supabase-explanation-live.ts`. One reader means a column renamed
 * later cannot be mapped correctly in one place and wrongly in the other,
 * which is the same reasoning as `questions/rows.ts`.
 *
 * It is NOT shared with `supabase-ai-client.ts`, which has its own private
 * copy of the same two readers: that file reads the Supabase env and ships
 * nothing to the browser, and importing it from a client component would pull
 * the server transport into the student's 150 KB bundle (DESIGN.md section
 * 10). The duplication is twenty lines of pure parsing with no branching.
 *
 * Every reader FAILS CLOSED. A body with no renderable sections is null, not
 * an empty explanation, because a student who paid for an explanation must
 * see the skeleton or an error and never a blank card.
 */
import { isExplanationStatus, type Explanation, type ExplanationBody, type ExplanationSource } from './types';

/** Never `select=*`, so a column added later cannot leak by accident. */
export const EXPLANATION_COLUMNS =
  'question_id,lang,status,body,sources,audio_path,edited_by_teacher';

export interface ExplanationRow {
  question_id?: unknown;
  lang?: unknown;
  status?: unknown;
  body?: unknown;
  sources?: unknown;
  audio_path?: unknown;
  edited_by_teacher?: unknown;
}

/** A link under the explanation. A source with no url is dropped. */
export function readExplanationSources(value: unknown): ExplanationSource[] {
  if (!Array.isArray(value)) return [];
  const out: ExplanationSource[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { title, url } = raw as Record<string, unknown>;
    if (typeof url !== 'string') continue;
    out.push({ title: typeof title === 'string' && title ? title : url, url });
  }
  return out;
}

/** A stored body is only usable when it has renderable sections. */
export function readExplanationBody(value: unknown): ExplanationBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) return null;

  const sections = raw.sections
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
    .filter((one) => typeof one.heading === 'string' && typeof one.body === 'string')
    .map((one) => ({ heading: String(one.heading), body: String(one.body) }));
  if (sections.length === 0) return null;

  return {
    exam: typeof raw.exam === 'string' ? raw.exam : '',
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    question: typeof raw.question === 'string' ? raw.question : '',
    sections,
    remember: typeof raw.remember === 'string' ? raw.remember : '',
  };
}

/**
 * One row of `ai_explanations` as the screen uses it, or null.
 *
 * A row with a status we do not recognise is DROPPED, never guessed at: an
 * unknown status could mean `failed` one day, and showing a failed row as a
 * finished explanation is the one mistake this file exists to prevent.
 */
export function readExplanationRow(row: unknown): Explanation | null {
  if (typeof row !== 'object' || row === null) return null;
  const raw = row as ExplanationRow;

  if (typeof raw.question_id !== 'string') return null;
  if (raw.lang !== 'en' && raw.lang !== 'hi') return null;
  if (!isExplanationStatus(raw.status)) return null;

  return {
    questionId: raw.question_id,
    lang: raw.lang,
    status: raw.status,
    body: readExplanationBody(raw.body),
    sources: readExplanationSources(raw.sources),
    audioPath: typeof raw.audio_path === 'string' ? raw.audio_path : null,
    editedByTeacher: raw.edited_by_teacher === true,
  };
}
