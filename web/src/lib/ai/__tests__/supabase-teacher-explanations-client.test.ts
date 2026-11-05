/**
 * The server-side teacher-explanations client, driven with a FAKE fetch
 * (issue 24-revision-teacher-edit).
 *
 * No real network call and no real key (web/CLAUDE.md). What is checked:
 *
 *  * the TEACHER'S OWN access token goes on every call, so the
 *    `ai_explanations_update_owner` policy and `auth.uid()` decide. There is
 *    no service-role key here, so a bug in this file cannot reach another
 *    teacher's row.
 *  * the save always sends `edited_by_teacher: true`, which is what
 *    `0024_teacher_edit.sql` now REQUIRES of a teacher update.
 *  * a save the policy refused (0 rows back) is reported as null, so the
 *    route can answer 404 instead of pretending it worked (Rule 2: never
 *    report a success that did not happen).
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseTeacherExplanationsClient } from '../supabase-teacher-explanations-client';
import type { EditExplanationInput } from '../teacher-edit';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-not-real',
};

const QUESTION = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';

const BODY = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
  remember: 'Rajya Sabha = Council of States.',
};

const INPUT: EditExplanationInput = { questionId: QUESTION, lang: 'en', body: BODY };

/** One row the way PostgREST returns it, with the question embedded. */
const ROW = {
  question_id: QUESTION,
  lang: 'en',
  body: BODY,
  edited_by_teacher: true,
  questions: { stem: 'Which house is the Council of States?', number: 1 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, env: Record<string, string> = ENV) {
  return createSupabaseTeacherExplanationsClient({
    accessToken: 'teacher-token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

describe('configuration', () => {
  it('is not configured with no env', () => {
    expect(clientWith(vi.fn() as unknown as typeof fetch, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily, so importing the module needs nothing', () => {
    expect(() =>
      createSupabaseTeacherExplanationsClient({ accessToken: '', userId: '' }),
    ).not.toThrow();
  });
});

describe('listMine', () => {
  it('asks only for the caller own questions, with the teacher token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [ROW]));
    const rows = await clientWith(fetchImpl as unknown as typeof fetch).listMine();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/ai_explanations');
    // `!inner` plus the filter is the whole reason a teacher cannot be shown
    // somebody else's row even if the policy were loosened one day.
    expect(url).toContain('questions!inner');
    expect(url).toContain(`questions.teacher_id=eq.${TEACHER}`);
    expect(url).toContain('status=eq.ready');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer teacher-token');

    expect(rows).toEqual([
      {
        questionId: QUESTION,
        lang: 'en',
        stem: 'Which house is the Council of States?',
        number: 1,
        body: BODY,
        editedByTeacher: true,
      },
    ]);
  });

  it('gives an empty list rather than throwing when Supabase says no', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { message: 'boom' }));
    expect(await clientWith(fetchImpl as unknown as typeof fetch).listMine()).toEqual([]);
  });

  it('drops a row it cannot draw instead of half-rendering it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [{ ...ROW, lang: 'fr' }, { ...ROW, body: { sections: [] } }, ROW]),
    );
    const rows = await clientWith(fetchImpl as unknown as typeof fetch).listMine();
    expect(rows).toHaveLength(1);
  });
});

describe('edit', () => {
  it('patches the one row and always sets edited_by_teacher', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [ROW]));
    const saved = await clientWith(fetchImpl as unknown as typeof fetch).edit(INPUT);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toContain(`question_id=eq.${QUESTION}`);
    expect(url).toContain('lang=eq.en');

    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toEqual({ body: BODY, edited_by_teacher: true });
    // Nothing else may be in the payload: the trigger would pin it anyway,
    // and sending it would make the intent of this call unclear.
    expect(Object.keys(sent).sort()).toEqual(['body', 'edited_by_teacher']);

    expect((init.headers as Record<string, string>).prefer).toContain('return=representation');
    expect(saved?.editedByTeacher).toBe(true);
    expect(saved?.body?.sections[0].body).toBe('The Rajya Sabha.');
  });

  it('returns null when the policy let no row through', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    expect(await clientWith(fetchImpl as unknown as typeof fetch).edit(INPUT)).toBeNull();
  });

  it('throws on an HTTP error, and the message carries only the status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { message: 'new row violates row-level security policy' }),
    );
    await expect(clientWith(fetchImpl as unknown as typeof fetch).edit(INPUT)).rejects.toThrow(
      /403/,
    );
    await expect(clientWith(fetchImpl as unknown as typeof fetch).edit(INPUT)).rejects.not.toThrow(
      /row-level/,
    );
  });

  it('throws when Supabase is not configured, rather than calling fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [ROW]));
    await expect(
      clientWith(fetchImpl as unknown as typeof fetch, {}).edit(INPUT),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
