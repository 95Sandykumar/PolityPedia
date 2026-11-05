/**
 * The server-side `ReportsClient` over Supabase REST (issue 20-batch-reports).
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md). What is asserted is the shape of the
 * request, because that shape is what the owner-rights views see:
 *
 *  * every call carries the CALLER'S OWN access token, never a service key,
 *  * both reads are filtered `batch_id=eq.<id>`, so one teacher's second batch
 *    cannot land in the first one's table,
 *  * neither read asks for `select=*`,
 *  * a batch id that is not a uuid never reaches a URL,
 *  * a missing env, a refusal and a broken row all give an EMPTY report, so a
 *    teacher's dashboard renders instead of throwing a 500.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseReportsClient } from '../supabase-reports-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const BATCH = '33333333-3333-4333-8333-333333333333';
const OTHER_BATCH = '44444444-4444-4444-8444-444444444444';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const TEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SET = '55555555-5555-4555-8555-555555555555';

const TEST_ROW = {
  test_id: TEST,
  set_id: SET,
  set_title: 'Full length set 1',
  test_title: 'Test 1',
  test_position: 1,
};

const SCORE_ROW = {
  user_id: STUDENT,
  test_id: TEST,
  score: 120,
  submitted_at: '2026-11-01T10:00:00Z',
};

/** Answers by which view the URL names, so the two reads can run in parallel. */
function router(
  tests: { body: unknown; status?: number },
  scores: { body: unknown; status?: number },
) {
  return vi.fn(async (url: string) => {
    const one = String(url).includes('batch_report_tests') ? tests : scores;
    return new Response(JSON.stringify(one.body), { status: one.status ?? 200 });
  });
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseReportsClient({ accessToken: 'caller.token', env, fetchImpl });
}

/** The one request that hit the named view. */
function callFor(doFetch: ReturnType<typeof vi.fn>, view: string) {
  const found = doFetch.mock.calls.find(([url]) => String(url).includes(view)) as
    | [string, RequestInit]
    | undefined;
  if (!found) throw new Error('no request for ' + view);
  return { url: found[0], headers: (found[1].headers ?? {}) as Record<string, string> };
}

describe('isConfigured', () => {
  it('is false with no env, so the page can say so', () => {
    expect(client(router({ body: [] }, { body: [] }) as unknown as typeof fetch, {}).isConfigured()).toBe(
      false,
    );
  });

  it('is true once both vars are set', () => {
    expect(client(router({ body: [] }, { body: [] }) as unknown as typeof fetch).isConfigured()).toBe(
      true,
    );
  });
});

describe('readBatchReport', () => {
  it('reads both views for that batch, with named columns only', async () => {
    const doFetch = router({ body: [TEST_ROW] }, { body: [SCORE_ROW] });
    const report = await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);

    expect(report.tests).toEqual([
      {
        testId: TEST,
        setId: SET,
        setTitle: 'Full length set 1',
        testTitle: 'Test 1',
        position: 1,
      },
    ]);
    expect(report.scores).toEqual([
      { userId: STUDENT, testId: TEST, score: 120, submittedAt: '2026-11-01T10:00:00Z' },
    ]);

    const tests = callFor(doFetch, 'batch_report_tests');
    expect(tests.url).toContain('/rest/v1/batch_report_tests');
    expect(tests.url).toContain('select=test_id,set_id,set_title,test_title,test_position');
    expect(tests.url).toContain('batch_id=eq.' + BATCH);
    expect(tests.url).not.toContain('select=*');

    const scores = callFor(doFetch, 'batch_report_scores');
    expect(scores.url).toContain('/rest/v1/batch_report_scores');
    expect(scores.url).toContain('select=user_id,test_id,score,submitted_at');
    expect(scores.url).toContain('batch_id=eq.' + BATCH);
    expect(scores.url).not.toContain('select=*');
  });

  it('carries the caller own token and the anon key, never a service key', async () => {
    const doFetch = router({ body: [] }, { body: [] });
    await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);

    for (const view of ['batch_report_tests', 'batch_report_scores']) {
      const { headers } = callFor(doFetch, view);
      expect(headers.authorization).toBe('Bearer caller.token');
      expect(headers.apikey).toBe('anon-key');
      expect(JSON.stringify(headers)).not.toContain('service');
    }
  });

  it('asks about ONE batch, so a second batch cannot land in this table', async () => {
    const doFetch = router({ body: [] }, { body: [] });
    await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);

    for (const view of ['batch_report_tests', 'batch_report_scores']) {
      expect(callFor(doFetch, view).url).not.toContain(OTHER_BATCH);
    }
  });

  it('never puts a batch id that is not a uuid into a URL', async () => {
    const doFetch = router({ body: [] }, { body: [] });
    const report = await client(doFetch as unknown as typeof fetch).readBatchReport(
      'not-a-uuid',
    );

    expect(report).toEqual({ tests: [], scores: [] });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('gives an empty report with no env, and asks nothing', async () => {
    const doFetch = router({ body: [] }, { body: [] });
    const report = await client(doFetch as unknown as typeof fetch, {}).readBatchReport(BATCH);

    expect(report).toEqual({ tests: [], scores: [] });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('gives an empty report when the view refuses, never a crash', async () => {
    const doFetch = router({ body: { message: 'nope' }, status: 403 }, { body: [], status: 500 });
    const report = await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);
    expect(report).toEqual({ tests: [], scores: [] });
  });

  it('drops a row it cannot read rather than half filling it', async () => {
    const doFetch = router(
      { body: [TEST_ROW, { test_id: TEST, set_id: SET }, 'nonsense'] },
      { body: [SCORE_ROW, { user_id: STUDENT, test_id: TEST, score: 'lots' }] },
    );
    const report = await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);

    expect(report.tests).toHaveLength(1);
    expect(report.scores).toHaveLength(1);
  });

  it('keeps a real zero, which is a score and not a missing cell', async () => {
    const doFetch = router({ body: [] }, { body: [{ ...SCORE_ROW, score: 0 }] });
    const report = await client(doFetch as unknown as typeof fetch).readBatchReport(BATCH);
    expect(report.scores[0].score).toBe(0);
  });
});
