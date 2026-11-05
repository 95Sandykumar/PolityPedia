/**
 * Issue 04-exams-onboarding: the browser-side data client.
 *
 * It posts to our own route handlers, so the page never holds a Supabase key.
 * `fetch` is injected, so no real network call happens in the test.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LANG_PATH,
  ONBOARDING_API_PATH,
  createBrowserExamsClient,
} from '../browser-exams-client';

function fakeFetch(status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status })) as unknown as typeof fetch;
}

function callOf(f: typeof fetch) {
  const mock = f as unknown as ReturnType<typeof vi.fn>;
  const [path, init] = mock.mock.calls[0] as [string, RequestInit];
  return { path, init, body: JSON.parse(String(init.body)) as unknown };
}

describe('createBrowserExamsClient', () => {
  it('posts the exams and the language to the onboarding route', async () => {
    const f = fakeFetch();
    await createBrowserExamsClient(f).saveOnboarding({ examIds: ['a', 'b'], lang: 'hi' });

    const { path, init, body } = callOf(f);
    expect(path).toBe(ONBOARDING_API_PATH);
    expect(init.method).toBe('POST');
    expect(body).toEqual({ examIds: ['a', 'b'], lang: 'hi' });
  });

  it('posts only the language to the language route', async () => {
    const f = fakeFetch();
    await createBrowserExamsClient(f).saveLang('both');

    const { path, body } = callOf(f);
    expect(path).toBe(LANG_PATH);
    expect(body).toEqual({ lang: 'both' });
  });

  it('throws on a failed response and never quotes the body', async () => {
    const f = vi.fn(
      async () => new Response('supabase said no', { status: 500 }),
    ) as unknown as typeof fetch;

    const error = await createBrowserExamsClient(f)
      .saveLang('en')
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(String(error)).toMatch(/failed with status 500/);
    expect(String(error)).not.toMatch(/supabase/i);
  });
});
