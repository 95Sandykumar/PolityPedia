/**
 * PATCH /api/teacher/explanations, the decision logic and the validator
 * (issue 24-revision-teacher-edit).
 *
 * The gate is the `ai_explanations_update_owner` policy inside Postgres, and
 * `test/teacher-edit.test.ts` proves it there. This file proves the layer in
 * front of it:
 *
 *  1. only an APPROVED teacher gets through, and the session says who.
 *  2. a body the student UI could not render is refused before the round trip.
 *  3. a row the policy refuses comes back as 404, never as a 500.
 *  4. the reply never quotes Postgres.
 *
 * The client is a fake backed by a Map: no real network call and no real key
 * (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import {
  MAX_REMEMBER,
  MAX_SECTIONS,
  MAX_SECTION_HEADING,
  readEditRequest,
  sortTeacherExplanations,
  type EditExplanationInput,
  type TeacherExplanation,
  type TeacherExplanationsClient,
} from '../teacher-edit';
import { handleEditExplanation } from '../teacher-edit-route';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TEACHER = '22222222-2222-4222-8222-222222222222';

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'token',
    refreshToken: 'r',
    userId: TEACHER,
    role: 'teacher',
    teacherStatus: 'approved',
    ...over,
  };
}

const GOOD_BODY = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha. Article 80.' }],
  remember: 'Rajya Sabha = Council of States.',
};

function row(over: Partial<TeacherExplanation> = {}): TeacherExplanation {
  return {
    questionId: QUESTION,
    lang: 'en',
    stem: 'Which house is the Council of States?',
    number: 1,
    body: GOOD_BODY,
    editedByTeacher: false,
    ...over,
  };
}

/**
 * A fake of the SQL: `owned` is the set of (question, lang) pairs the policy
 * would let this teacher write. Anything else saves nothing, like a 0-row
 * update.
 */
function fakeClient(
  owned: readonly string[] = [QUESTION + ':en'],
  over: Partial<TeacherExplanationsClient> = {},
): TeacherExplanationsClient {
  return {
    isConfigured: () => true,
    listMine: async () => [row()],
    edit: async (input: EditExplanationInput) => {
      if (!owned.includes(input.questionId + ':' + input.lang)) return null;
      // The trigger in 0024 is what really sets this. The fake mirrors it, so
      // the route can be trusted to pass the flag on to the browser.
      return row({ ...input, editedByTeacher: true });
    },
    ...over,
  };
}

describe('readEditRequest', () => {
  it('accepts the shape the teacher form sends', () => {
    expect(
      readEditRequest({ question_id: QUESTION, lang: 'en', body: GOOD_BODY }),
    ).toEqual({ questionId: QUESTION, lang: 'en', body: GOOD_BODY });
  });

  it('accepts the camelCase spelling too', () => {
    expect(readEditRequest({ questionId: QUESTION, lang: 'hi', body: GOOD_BODY })?.lang).toBe('hi');
  });

  it('trims every string a teacher typed', () => {
    const got = readEditRequest({
      questionId: QUESTION,
      lang: 'en',
      body: {
        ...GOOD_BODY,
        remember: '  Rajya Sabha  ',
        sections: [{ heading: '  Answer  ', body: '  The Rajya Sabha.  ' }],
      },
    });
    expect(got?.body.remember).toBe('Rajya Sabha');
    expect(got?.body.sections[0]).toEqual({ heading: 'Answer', body: 'The Rajya Sabha.' });
  });

  it('refuses a body with nothing to render', () => {
    expect(readEditRequest({ questionId: QUESTION, lang: 'en', body: GOOD_BODY })).not.toBeNull();
    expect(
      readEditRequest({ questionId: QUESTION, lang: 'en', body: { ...GOOD_BODY, sections: [] } }),
    ).toBeNull();
    expect(
      readEditRequest({
        questionId: QUESTION,
        lang: 'en',
        body: { ...GOOD_BODY, sections: [{ heading: 'Answer', body: '   ' }] },
      }),
    ).toBeNull();
    expect(readEditRequest({ questionId: QUESTION, lang: 'en' })).toBeNull();
  });

  it('refuses a bad id, a bad language, and the display mode `both`', () => {
    expect(readEditRequest({ questionId: 'nope', lang: 'en', body: GOOD_BODY })).toBeNull();
    expect(readEditRequest({ questionId: QUESTION, lang: 'both', body: GOOD_BODY })).toBeNull();
    expect(readEditRequest({ questionId: QUESTION, lang: 'fr', body: GOOD_BODY })).toBeNull();
    expect(readEditRequest(null)).toBeNull();
    expect(readEditRequest('a string')).toBeNull();
  });

  it('refuses more sections than the screen was built for', () => {
    const sections = Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => ({
      heading: 'H' + i,
      body: 'B' + i,
    }));
    expect(readEditRequest({ questionId: QUESTION, lang: 'en', body: { ...GOOD_BODY, sections } }))
      .toBeNull();
  });

  it('cuts an over-long heading and remember line instead of refusing', () => {
    const got = readEditRequest({
      questionId: QUESTION,
      lang: 'en',
      body: {
        ...GOOD_BODY,
        remember: 'r'.repeat(MAX_REMEMBER + 50),
        sections: [{ heading: 'h'.repeat(MAX_SECTION_HEADING + 50), body: 'ok' }],
      },
    });
    expect(got?.body.remember).toHaveLength(MAX_REMEMBER);
    expect(got?.body.sections[0].heading).toHaveLength(MAX_SECTION_HEADING);
  });
});

describe('sortTeacherExplanations', () => {
  it('puts the ones still waiting on the human gate first', () => {
    const sorted = sortTeacherExplanations([
      row({ questionId: OTHER, number: 1, editedByTeacher: true }),
      row({ questionId: QUESTION, number: 2, editedByTeacher: false }),
    ]);
    expect(sorted.map((r) => r.editedByTeacher)).toEqual([false, true]);
  });

  it('then orders by question number, and English before Hindi', () => {
    const sorted = sortTeacherExplanations([
      row({ number: 2, lang: 'en' }),
      row({ number: 1, lang: 'hi' }),
      row({ number: 1, lang: 'en' }),
      row({ number: null, lang: 'en' }),
    ]);
    expect(sorted.map((r) => [r.number, r.lang])).toEqual([
      [1, 'en'],
      [1, 'hi'],
      [2, 'en'],
      [null, 'en'],
    ]);
  });
});

describe('handleEditExplanation: who may save', () => {
  it('refuses a visitor who is not signed in', async () => {
    const client = fakeClient();
    const spy = vi.spyOn(client, 'edit');

    const reply = await handleEditExplanation({
      body: { questionId: QUESTION, lang: 'en', body: GOOD_BODY },
      session: null,
      client,
    });

    expect(reply.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a student', async () => {
    const reply = await handleEditExplanation({
      body: { questionId: QUESTION, lang: 'en', body: GOOD_BODY },
      session: session({ role: 'student', teacherStatus: undefined }),
      client: fakeClient(),
    });
    expect(reply.status).toBe(403);
  });

  it('refuses a teacher who is not approved yet, and a missing status', async () => {
    for (const teacherStatus of ['pending', undefined] as const) {
      const reply = await handleEditExplanation({
        body: { questionId: QUESTION, lang: 'en', body: GOOD_BODY },
        session: session({ teacherStatus }),
        client: fakeClient(),
      });
      expect(reply.status).toBe(403);
    }
  });

  it('says so when Supabase is not configured', async () => {
    const reply = await handleEditExplanation({
      body: { questionId: QUESTION, lang: 'en', body: GOOD_BODY },
      session: session(),
      client: fakeClient([QUESTION + ':en'], { isConfigured: () => false }),
    });
    expect(reply.status).toBe(503);
  });
});

describe('handleEditExplanation: saving', () => {
  it('saves an approved teacher own explanation and marks it edited', async () => {
    const reply = await handleEditExplanation({
      body: { question_id: QUESTION, lang: 'en', body: GOOD_BODY },
      session: session(),
      client: fakeClient(),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      ok: true,
      explanation: row({ body: GOOD_BODY, editedByTeacher: true }),
    });
  });

  it('answers 404 when the policy let no row through', async () => {
    const reply = await handleEditExplanation({
      body: { questionId: OTHER, lang: 'en', body: GOOD_BODY },
      session: session(),
      client: fakeClient(),
    });

    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: 'not found' });
  });

  it('answers 400 for a body the student UI could not render', async () => {
    const client = fakeClient();
    const spy = vi.spyOn(client, 'edit');

    const reply = await handleEditExplanation({
      body: { questionId: QUESTION, lang: 'en', body: { ...GOOD_BODY, sections: [] } },
      session: session(),
      client,
    });

    expect(reply.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never quotes Postgres when the save throws', async () => {
    const reply = await handleEditExplanation({
      body: { questionId: QUESTION, lang: 'en', body: GOOD_BODY },
      session: session(),
      client: fakeClient([QUESTION + ':en'], {
        edit: async () => {
          throw new Error('new row violates row-level security policy for table');
        },
      }),
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});
