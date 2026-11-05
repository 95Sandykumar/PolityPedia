/**
 * The worker's store over PostgREST (issue 12-pdf-split-worker).
 *
 * `fetch` is FAKED, so no Supabase project is touched and no real key exists
 * in this file (web/CLAUDE.md). What it proves:
 *
 *  1. the claim goes through `claim_ingest_job()`, not a hand-written UPDATE,
 *     so the atomicity stays in the SQL;
 *  2. the drafts it writes never carry `status` or `checked` (Risk 1);
 *  3. a re-run deletes this job's own DRAFTS and nothing else (D4);
 *  4. with no key it is `isConfigured() === false` and sends nothing;
 *  5. an error carries the HTTP status and never the response body.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseSplitStore } from '../supabase-split-store';
import type { IngestJob } from '@/lib/questions/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-not-a-real-key',
};

const JOB: IngestJob = {
  id: '33333333-3333-4333-8333-333333333333',
  teacherId: '11111111-1111-4111-8111-111111111111',
  paperId: '22222222-2222-4222-8222-222222222222',
  pdfPath: 'teacher/abc-questions.pdf',
  status: 'running',
  attempts: 1,
  error: null,
  questionCount: 0,
};

const ROW = {
  id: JOB.id,
  teacher_id: JOB.teacherId,
  paper_id: JOB.paperId,
  pdf_path: JOB.pdfPath,
  status: 'running',
  attempts: 1,
  error: null,
  question_count: 0,
};

function fakeFetch(answers: unknown[], status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answers.shift() ?? null,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function store(impl: typeof fetch) {
  return createSupabaseSplitStore({ env: ENV, fetchImpl: impl });
}

describe('createSupabaseSplitStore', () => {
  it('is not configured without the service-role key, and sends nothing', async () => {
    const { impl, calls } = fakeFetch([]);
    const one = createSupabaseSplitStore({
      env: { NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL },
      fetchImpl: impl,
    });

    expect(one.isConfigured()).toBe(false);
    await expect(one.claimQueuedJob()).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it('claims through the SQL function, not a hand-written update', async () => {
    const { impl, calls } = fakeFetch([[ROW]]);

    const job = await store(impl).claimQueuedJob();

    expect(job).toEqual(JOB);
    expect(calls).toHaveLength(1);
    // The atomicity (`for update skip locked`) lives in 0012, so the client
    // must call the function and never PATCH the table itself.
    expect(calls[0].url).toBe('https://project.supabase.co/rest/v1/rpc/claim_ingest_job');
    expect(calls[0].init.method).toBe('POST');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(headers.authorization).toBe('Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('reads an empty queue as null, not as an error', async () => {
    const { impl } = fakeFetch([[]]);
    expect(await store(impl).claimQueuedJob()).toBeNull();
  });

  it('drops a row it cannot read rather than guessing', async () => {
    // An unknown status could mean `done` one day. Guessing is how a job gets
    // split twice.
    const { impl } = fakeFetch([[{ ...ROW, status: 'something-new' }]]);
    expect(await store(impl).claimQueuedJob()).toBeNull();
  });

  it('writes drafts with no status and no checked flag (Risk 1)', async () => {
    const { impl, calls } = fakeFetch([null]);

    const count = await store(impl).insertDrafts({
      job: JOB,
      questions: [
        {
          stem: 'Who appoints the Governor?',
          options: ['President', 'PM', 'CM', 'CJ'],
          correctIdx: 0,
          explanation: 'Article 155.',
        },
        {
          stem: 'And the second one?',
          options: ['a', 'b', 'c', 'd'],
          correctIdx: 2,
          explanation: null,
        },
      ],
    });

    expect(count).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://project.supabase.co/rest/v1/questions');

    const rows = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    // The column defaults are `draft` and `false`, so leaving them out means
    // no typo in this file can ever ask for a live row.
    for (const row of rows) {
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('checked');
      expect(row.teacher_id).toBe(JOB.teacherId);
      expect(row.paper_id).toBe(JOB.paperId);
      expect(row.job_id).toBe(JOB.id);
      expect(row.lang).toBe('en');
    }
    // 1-based, in the order the model read them off the page.
    expect(rows.map((row) => row.number)).toEqual([1, 2]);
    expect(rows[0].teacher_explanation).toBe('Article 155.');
    expect(rows[1].teacher_explanation).toBeNull();
    expect(rows[0].correct_idx).toBe(0);
  });

  it('sends nothing for an empty list', async () => {
    const { impl, calls } = fakeFetch([]);
    expect(await store(impl).insertDrafts({ job: JOB, questions: [] })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses more than 200 questions before it sends anything', async () => {
    const { impl, calls } = fakeFetch([]);
    const many = Array.from({ length: 201 }, () => ({
      stem: 'q',
      options: ['a', 'b', 'c', 'd'] as [string, string, string, string],
      correctIdx: 0,
      explanation: null,
    }));

    await expect(store(impl).insertDrafts({ job: JOB, questions: many })).rejects.toThrow(
      /at most 200/,
    );
    expect(calls).toHaveLength(0);
  });

  it('deletes only this job\'s DRAFTS on a re-run (D4)', async () => {
    const { impl, calls } = fakeFetch([[{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]]);

    expect(await store(impl).deleteDraftsForJob(JOB.id)).toBe(3);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toContain('job_id=eq.' + JOB.id);
    // The safety rail: a published question is content a student can see, and
    // a worker must never delete content.
    expect(calls[0].url).toContain('status=eq.draft');
  });

  it('refuses a job id that is not a uuid', async () => {
    const { impl, calls } = fakeFetch([]);
    // The id goes straight into a URL filter.
    await expect(store(impl).deleteDraftsForJob('../../all')).rejects.toThrow(/uuid/);
    await expect(store(impl).failJob({ jobId: 'oops', error: 'bad-answer' })).rejects.toThrow(
      /uuid/,
    );
    expect(calls).toHaveLength(0);
  });

  it('finishes a job with the count and clears the error', async () => {
    const { impl, calls } = fakeFetch([null]);
    await store(impl).finishJob({ jobId: JOB.id, questionCount: 42 });

    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url).toContain('id=eq.' + JOB.id);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      status: 'done',
      question_count: 42,
      error: null,
    });
  });

  it('fails a job with a stable CODE, never a sentence', async () => {
    const { impl, calls } = fakeFetch([null]);
    await store(impl).failJob({ jobId: JOB.id, error: 'too-many' });

    // The review screen turns the code into English and Hindi. A model's own
    // words are not translatable and could repeat what a hostile PDF said.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      status: 'failed',
      error: 'too-many',
    });
  });

  it('records which try we are on', async () => {
    const { impl, calls } = fakeFetch([null]);
    await store(impl).setAttempts(JOB.id, 3);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ attempts: 3 });
  });

  it('throws the status and never the response body', async () => {
    const { impl } = fakeFetch([{ message: 'policy "ingest_jobs_select_own" blocked it' }], 403);

    await expect(store(impl).claimQueuedJob()).rejects.toThrow(
      'claim_ingest_job failed with status 403',
    );
    await expect(store(impl).claimQueuedJob()).rejects.not.toThrow(/policy/);
  });
});
