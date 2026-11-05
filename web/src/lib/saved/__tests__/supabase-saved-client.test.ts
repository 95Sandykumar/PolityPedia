/**
 * The server-side SavedClient over Supabase REST (issue 14-saved-list).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values. Every call carries the SIGNED-IN STUDENT'S own
 * access token, so the `saved_questions_*_own` policies in Postgres are the
 * gate.
 *
 * The one line that matters most is the save: `on_conflict=user_id,question_id,tag`
 * plus `resolution=merge-duplicates`, which is what makes a wrong answer saved
 * twice ONE row (the key in `0014_saved.sql`).
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseSavedClient } from '../supabase-saved-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'caller.access.token';
const STUDENT = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222221';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 200, body: null };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseSavedClient({
    accessToken: ACCESS_TOKEN,
    userId: STUDENT,
    env,
    fetchImpl,
  });
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('isConfigured', () => {
  it('is false with no env, so the page can say "not set up"', () => {
    const { fn } = fakeFetch();
    expect(client(fn, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily: creating the client touches nothing', () => {
    const { fn, calls } = fakeFetch();
    client(fn, {});
    expect(calls).toHaveLength(0);
  });
});

describe('save', () => {
  it('upserts on the whole key, so the same save twice is one row', async () => {
    const { fn, calls } = fakeFetch([{ status: 201 }]);
    await client(fn).save(QUESTION, 'wrong');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/saved_questions');
    expect(calls[0].url).toContain('on_conflict=user_id,question_id,tag');
    expect(headers(calls[0]).prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      user_id: STUDENT,
      question_id: QUESTION,
      tag: 'wrong',
    });
  });

  it('carries the caller token and the project key, never a service role', async () => {
    const { fn, calls } = fakeFetch([{ status: 201 }]);
    await client(fn).save(QUESTION, 'marked');

    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
    expect(headers(calls[0]).apikey).toBe('test-anon-key');
  });

  it('refuses a question id that is not a uuid before any request', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).save('q1', 'wrong')).rejects.toThrow(/uuid/i);
    expect(calls).toHaveLength(0);
  });

  it('throws the status only, never the Supabase body', async () => {
    const { fn } = fakeFetch([
      { status: 403, body: { message: 'violates row-level security policy' } },
    ]);

    const thrown = await client(fn)
      .save(QUESTION, 'wrong')
      .then(() => null)
      .catch((error: Error) => error.message);

    expect(thrown).toMatch(/403/);
    expect(thrown).not.toMatch(/policy|row-level/i);
  });
});

describe('remove', () => {
  it('filters on the caller own id, the question AND the tag', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);
    await client(fn).remove(QUESTION, 'marked');

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toContain('user_id=eq.' + STUDENT);
    expect(calls[0].url).toContain('question_id=eq.' + QUESTION);
    expect(calls[0].url).toContain('tag=eq.marked');
  });
});

describe('list', () => {
  it('reads the saved rows with the question joined, newest first', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: [
          {
            question_id: QUESTION,
            tag: 'wrong',
            created_at: '2026-11-05T10:00:00+00:00',
            questions: {
              teacher_id: TEACHER,
              paper_id: PAPER,
              number: 7,
              stem: 'Which house is the Council of States?',
            },
          },
        ],
      },
    ]);

    const items = await client(fn).list();

    expect(calls[0].url).toContain('order=created_at.desc');
    expect(items).toEqual([
      {
        questionId: QUESTION,
        tag: 'wrong',
        createdAt: '2026-11-05T10:00:00+00:00',
        teacherId: TEACHER,
        paperId: PAPER,
        number: 7,
        stem: 'Which house is the Council of States?',
      },
    ]);
  });

  it('drops a row whose question the student may not read', async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: [
          { question_id: QUESTION, tag: 'wrong', created_at: null, questions: null },
          { question_id: QUESTION, tag: 'later', created_at: null, questions: {} },
        ],
      },
    ]);

    expect(await client(fn).list()).toEqual([]);
  });

  it('is an empty list on any failure, so the tab still renders', async () => {
    const { fn } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    expect(await client(fn).list()).toEqual([]);
  });
});
