/**
 * Issue 04-exams-onboarding: the server-side data client.
 *
 * Plain `fetch` against the Supabase REST API, injected here, so the test
 * makes no real network call and uses no real key. Env is read lazily, so an
 * unconfigured project says so instead of throwing at import time.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseExamsClient } from '../supabase-exams-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const CALLER = { accessToken: 'user-access-token', userId: 'user-1' };

const EXAM_ROW = {
  id: 'e1',
  code: 'ugc_net_pol_sci',
  name_en: 'UGC NET Political Science',
  name_hi: 'यूजीसी नेट राजनीति विज्ञान',
  marks_correct: '2.00',
  marks_wrong: '0.00',
  duration_min: null,
  question_count: null,
  marking_unverified: true,
};

type Call = [string, RequestInit];

/** Answers each request in order with the given JSON payloads. */
function fakeFetch(payloads: unknown[]) {
  let index = 0;
  return vi.fn(async () => {
    const body = payloads[Math.min(index++, payloads.length - 1)];
    return new Response(JSON.stringify(body ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function calls(f: typeof fetch): Call[] {
  return (f as unknown as ReturnType<typeof vi.fn>).mock.calls as Call[];
}

describe('createSupabaseExamsClient', () => {
  it('reports "not configured" when the env vars are missing', () => {
    const client = createSupabaseExamsClient({ env: {}, fetchImpl: fakeFetch([]) });
    expect(client.isConfigured()).toBe(false);
  });

  it('is configured once both env vars exist', () => {
    const client = createSupabaseExamsClient({ env: ENV, fetchImpl: fakeFetch([]) });
    expect(client.isConfigured()).toBe(true);
  });

  it('reads the exam catalogue with the signed-in user token', async () => {
    const f = fakeFetch([[EXAM_ROW]]);
    const exams = await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).listExams(CALLER);

    expect(exams).toEqual([
      {
        id: 'e1',
        code: 'ugc_net_pol_sci',
        nameEn: 'UGC NET Political Science',
        nameHi: 'यूजीसी नेट राजनीति विज्ञान',
        marksCorrect: 2,
        marksWrong: 0,
        durationMin: null,
        questionCount: null,
        markingUnverified: true,
      },
    ]);

    const [path, init] = calls(f)[0];
    expect(path).toContain('https://project.supabase.co/rest/v1/exams');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer user-access-token');
  });

  it('reads the saved language and whether exams were already picked', async () => {
    const f = fakeFetch([[{ lang: 'hi' }], [{ exam_id: 'e1' }]]);
    const state = await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).readStudentState(
      CALLER,
    );
    expect(state).toEqual({ lang: 'hi', hasExams: true });
  });

  it('falls back to English and "no exams yet" for a brand new student', async () => {
    const f = fakeFetch([[], []]);
    const state = await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).readStudentState(
      CALLER,
    );
    expect(state).toEqual({ lang: 'en', hasExams: false });
  });

  it('replaces the picked exams and writes the language', async () => {
    const f = fakeFetch([null, null, null]);
    await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).saveOnboarding(CALLER, {
      examIds: ['e1', 'e2'],
      lang: 'hi',
    });

    const made = calls(f);
    expect(made).toHaveLength(3);

    // 1. drop the old picks, so a re-run of onboarding is idempotent
    expect(made[0][0]).toContain('/rest/v1/student_exams?user_id=eq.user-1');
    expect(made[0][1].method).toBe('DELETE');

    // 2. insert the new picks, each row stamped with the caller's own id (RLS)
    expect(made[1][0]).toContain('/rest/v1/student_exams');
    expect(made[1][1].method).toBe('POST');
    expect(JSON.parse(String(made[1][1].body))).toEqual([
      { user_id: 'user-1', exam_id: 'e1' },
      { user_id: 'user-1', exam_id: 'e2' },
    ]);

    // 3. the language goes on the student's own profile row
    expect(made[2][0]).toContain('/rest/v1/profiles?id=eq.user-1');
    expect(made[2][1].method).toBe('PATCH');
    expect(JSON.parse(String(made[2][1].body))).toEqual({ lang: 'hi' });
  });

  it('skips the insert when no exam was picked', async () => {
    const f = fakeFetch([null, null]);
    await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).saveOnboarding(CALLER, {
      examIds: [],
      lang: 'en',
    });
    expect(calls(f).map((c) => c[1].method)).toEqual(['DELETE', 'PATCH']);
  });

  it('writes only profiles.lang when the language alone changes', async () => {
    const f = fakeFetch([null]);
    await createSupabaseExamsClient({ env: ENV, fetchImpl: f }).saveLang(CALLER, 'both');

    const made = calls(f);
    expect(made).toHaveLength(1);
    expect(made[0][0]).toContain('/rest/v1/profiles?id=eq.user-1');
    expect(made[0][1].method).toBe('PATCH');
    expect(JSON.parse(String(made[0][1].body))).toEqual({ lang: 'both' });
  });

  it('throws a fixed message with the status, never the response body', async () => {
    const f = vi.fn(
      async () => new Response('supabase said no', { status: 500 }),
    ) as unknown as typeof fetch;

    const error = await createSupabaseExamsClient({ env: ENV, fetchImpl: f })
      .saveLang(CALLER, 'en')
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(String(error)).toMatch(/failed with status 500/);
    expect(String(error)).not.toMatch(/said no/);
  });
});
