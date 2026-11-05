/**
 * The teacher-edit contract (issue 24-revision-teacher-edit).
 *
 * F7 is the human gate on AI text and F-F4 says the question's teacher is the
 * one who closes it. The gate itself is the `ai_explanations_update_owner`
 * policy plus the `ai_explanations_teacher_edit` trigger in
 * `0024_teacher_edit.sql`. Everything here is the layer in front of it:
 * the shapes, and the one validator that keeps a body the student screen
 * could not render from ever reaching Postgres.
 *
 * Kept apart from `types.ts` (issue 22) so the two slices never collide in the
 * same file. It reuses `ExplanationBody` from there, because an edited
 * explanation is the SAME shape as a written one: the student UI has one
 * renderer, not two.
 *
 * Nothing here reads `process.env` or calls `fetch`, so importing this file
 * can never break a build that has no environment variables (web/CLAUDE.md).
 */
import type { Lang } from '@/lib/i18n';
import type { ExplanationBody, ExplanationSection } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Limits. All of them are about what the student screen can draw, not about
 * what Postgres can hold, which is why they live next to the form and not in
 * the migration. Over-long text is CUT, never refused: the teacher has
 * already typed it and losing the lot is a worse answer than a short one.
 */
export const MAX_SECTIONS = 8;
export const MAX_SECTION_HEADING = 80;
export const MAX_SECTION_BODY = 2_000;
export const MAX_REMEMBER = 240;
/** `exam`, `topic` and `question` are chips at the top of the screen. */
export const MAX_CHIP = 160;

/** One row of the teacher's own explanation list. */
export interface TeacherExplanation {
  questionId: string;
  lang: Lang;
  /** The question itself, so the teacher knows what they are correcting. */
  stem: string;
  /** Number inside its paper. Null for a mock-test question. */
  number: number | null;
  /** Null while the AI call is still in flight or has failed. */
  body: ExplanationBody | null;
  /** True once corrected. The student UI then drops the AI label. */
  editedByTeacher: boolean;
}

/** One save. The teacher is NOT in it: that comes from the session. */
export interface EditExplanationInput {
  questionId: string;
  lang: Lang;
  body: ExplanationBody;
}

/** Server side. Carries the teacher's own token, so Postgres decides. */
export interface TeacherExplanationsClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** Explanations of the caller's own questions. */
  listMine(): Promise<TeacherExplanation[]>;
  /** Save one. Null when the policy let no row through (not yours, or gone). */
  edit(input: EditExplanationInput): Promise<TeacherExplanation | null>;
}

/** Browser side. Calls our own route; never sees a Supabase key. */
export interface BrowserTeacherExplanationsClient {
  edit(input: EditExplanationInput): Promise<TeacherExplanation>;
}

/**
 * The list order, and it is a product decision, not a tidiness one: the rows
 * a student still sees credited to the model come FIRST, because those are
 * the ones waiting on the human gate (F7). Then paper order, then English
 * before Hindi, so the same question's two languages sit together.
 *
 * A question with no number (a mock-test one) sorts last rather than first:
 * `null` is "not in a paper", not "question zero".
 */
export function sortTeacherExplanations(
  rows: readonly TeacherExplanation[],
): TeacherExplanation[] {
  return [...rows].sort((a, b) => {
    if (a.editedByTeacher !== b.editedByTeacher) return a.editedByTeacher ? 1 : -1;
    if (a.number !== b.number) {
      if (a.number === null) return 1;
      if (b.number === null) return -1;
      return a.number - b.number;
    }
    if (a.lang !== b.lang) return a.lang === 'en' ? -1 : 1;
    return a.questionId.localeCompare(b.questionId, 'en');
  });
}

/** Trim, then cut to `max`. Anything that is not a string reads as empty. */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * Validate anything into an `EditExplanationInput`, or null.
 *
 * `lang` is a stored LANGUAGE, never the display mode `both`: an explanation
 * is written in one language, like the question it explains.
 *
 * Refusal, not repair, for the three things the student screen cannot survive:
 * no sections at all, a section with no text in it, and more sections than the
 * screen was built for. Those mean the form sent something wrong, and saving a
 * half-empty correction over a readable one is the worse outcome.
 */
export function readEditRequest(value: unknown): EditExplanationInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  // Accepted under the wire name the SQL column uses as well, so the form, the
  // route and the table are all spelled the same.
  const questionId = raw.question_id ?? raw.questionId;
  if (typeof questionId !== 'string' || !UUID_RE.test(questionId)) return null;

  const lang = raw.lang;
  if (lang !== 'en' && lang !== 'hi') return null;

  const body = raw.body;
  if (typeof body !== 'object' || body === null) return null;
  const rawBody = body as Record<string, unknown>;

  if (!Array.isArray(rawBody.sections)) return null;
  if (rawBody.sections.length === 0 || rawBody.sections.length > MAX_SECTIONS) return null;

  const sections: ExplanationSection[] = [];
  for (const section of rawBody.sections) {
    if (typeof section !== 'object' || section === null) return null;
    const { heading, body: sectionBody } = section as Record<string, unknown>;

    const cleanBody = text(sectionBody, MAX_SECTION_BODY);
    // An empty section is a blank card on a student's screen, and a blank
    // human gate is worse than no gate. `0024` refuses it too.
    if (cleanBody.length === 0) return null;

    sections.push({ heading: text(heading, MAX_SECTION_HEADING), body: cleanBody });
  }

  return {
    questionId,
    lang,
    body: {
      exam: text(rawBody.exam, MAX_CHIP),
      topic: text(rawBody.topic, MAX_CHIP),
      question: text(rawBody.question, MAX_CHIP),
      sections,
      remember: text(rawBody.remember, MAX_REMEMBER),
    },
  };
}
