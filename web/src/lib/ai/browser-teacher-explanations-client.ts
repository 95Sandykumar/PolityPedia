/**
 * Browser-side teacher-explanations client (issue 24-revision-teacher-edit).
 *
 * The page never holds a Supabase key and never sees a token. It calls our own
 * route handler; that reads the teacher's access token out of the httpOnly
 * session cookie and lets Postgres RLS decide.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import type {
  BrowserTeacherExplanationsClient,
  EditExplanationInput,
  TeacherExplanation,
} from './teacher-edit';
import type { ExplanationBody } from './types';

export const TEACHER_EXPLANATIONS_API = '/api/teacher/explanations';

export function createBrowserTeacherExplanationsClient(
  fetchImpl?: typeof fetch,
): BrowserTeacherExplanationsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async edit(input: EditExplanationInput) {
      const res = await doFetch(TEACHER_EXPLANATIONS_API, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: input.questionId,
          lang: input.lang,
          body: input.body,
        }),
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { explanation?: unknown };
      const saved = readExplanation(body.explanation);
      if (!saved) throw new Error('Request returned no explanation');
      return saved;
    },
  };
}

/**
 * The reply is still a response off the network, so it is checked like any
 * other before it goes back into the teacher's list.
 */
function readExplanation(value: unknown): TeacherExplanation | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;

  if (typeof row.questionId !== 'string') return null;
  if (row.lang !== 'en' && row.lang !== 'hi') return null;

  const body = readBody(row.body);
  if (!body) return null;

  return {
    questionId: row.questionId,
    lang: row.lang,
    stem: typeof row.stem === 'string' ? row.stem : '',
    number: typeof row.number === 'number' ? row.number : null,
    body,
    // The flag the whole slice turns on. Read strictly: anything other than a
    // real `true` leaves the row labelled as AI text, which is the safe side.
    editedByTeacher: row.editedByTeacher === true,
  };
}

function readBody(value: unknown): ExplanationBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) return null;

  const sections = raw.sections
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .filter((s) => typeof s.body === 'string' && s.body.trim().length > 0)
    .map((s) => ({
      heading: typeof s.heading === 'string' ? s.heading : '',
      body: String(s.body),
    }));
  if (sections.length === 0) return null;

  return {
    exam: typeof raw.exam === 'string' ? raw.exam : '',
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    question: typeof raw.question === 'string' ? raw.question : '',
    sections,
    remember: typeof raw.remember === 'string' ? raw.remember : '',
  };
}
