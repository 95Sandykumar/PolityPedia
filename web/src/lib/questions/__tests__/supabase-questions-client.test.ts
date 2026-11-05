/**
 * Server-side questions and split-job clients
 * (issue 11-ingest-job-review-publish).
 *
 * `fetch` and the env bag are injected, so there is no real network call and
 * no real key in this test (web/CLAUDE.md).
 *
 * What it has to prove, beyond the plumbing:
 *  * every call carries the CALLER's own token, so RLS is the gate.
 *  * `save` never sends a `status` or a `teacher_id` out of the body.
 *  * `publishPaper` turns the three Postgres refusals into three NAMED errors,
 *    so the route can answer without ever echoing a Postgres message.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSupabaseIngestJobsClient,
  createSupabaseQuestionsClient,
} from '../supabase-questions-client';
import type { QuestionEdit } from '../types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const QUESTION = '66666666-6666-4666-8666-666666666666';

function questionRow(over: Record<string, unknown> = {}) {
  return {
    id: QUESTION,
    teacher_id: TEACHER,
    paper_id: PAPER,
    test_id: null,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correct_idx: 1,
    teacher_explanation: null,
    topic_id: null,
    lang: 'en',
    image_path: null,
    checked: false,
    status: 'draft',
    ...over,
  };
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    teacher_id: TEACHER,
    paper_id: PAPER,
    pdf_path: 'papers/q.pdf',
    status: 'queued',
    attempts: 0,
    error: null,
    question_count: 0,
    ...over,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function questions(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseQuestionsClient({
    accessToken: 'caller-token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

function jobs(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseIngestJobsClient({
    accessToken: 'caller-token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

const EDIT: QuestionEdit = {
  id: null,
  paperId: PAPER,
  number: 1,
  stem: 'Which house is the Council of States?',
  options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
  correctIdx: 1,
  teacherExplanation: 'Article 80.',
  lang: 'en',
  checked: true,
};

describe('createSupabaseQuestionsClient', () => {
  it('reports not configured with no env, and never fires a request', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = questions(fetchImpl as unknown as typeof fetch, {});

    expect(client.isConfigured()).toBe(false);
    expect(await client.listForPaper(PAPER)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists one paper questions in number order, with the caller own token', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow()]));
    const client = questions(fetchImpl as unknown as typeof fetch);

    const rows = await client.listForPaper(PAPER);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/questions');
    expect(url).toContain(`paper_id=eq.${PAPER}`);
    expect(url).toContain('order=number.asc');
    expect(url).not.toContain('select=*');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer caller-token');

    expect(rows).toEqual([
      {
        id: QUESTION,
        teacherId: TEACHER,
        paperId: PAPER,
        testId: null,
        number: 1,
        stem: 'Which house is the Council of States?',
        options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
        correctIdx: 1,
        teacherExplanation: null,
        topicId: null,
        lang: 'en',
        imagePath: null,
        checked: false,
        status: 'draft',
      },
    ]);
  });

  it('drops a row whose options are not four strings, instead of showing three', async () => {
    const fetchImpl = vi.fn(async () =>
      json([questionRow({ options: ['a', 'b', 'c'] }), questionRow({ id: PAPER })]),
    );
    const client = questions(fetchImpl as unknown as typeof fetch);
    const rows = await client.listForPaper(PAPER);
    expect(rows.map((one) => one.id)).toEqual([PAPER]);
  });

  it('drops a row whose status it does not recognise (Risk 1)', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow({ status: 'published' })]));
    const client = questions(fetchImpl as unknown as typeof fetch);
    expect(await client.listForPaper(PAPER)).toEqual([]);
  });

  it('gives an empty list, never a crash, when Supabase says no', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'nope' }, 500));
    const client = questions(fetchImpl as unknown as typeof fetch);
    expect(await client.listForPaper(PAPER)).toEqual([]);
  });

  it('refuses a paper id that is not a uuid, before building a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = questions(fetchImpl as unknown as typeof fetch);
    expect(await client.listForPaper('paper-1')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('inserts a new question as a DRAFT owned by the session user', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow({ checked: true })]));
    const client = questions(fetchImpl as unknown as typeof fetch);

    const saved = await client.save(EDIT);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain('/rest/v1/questions');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.teacher_id).toBe(TEACHER);
    expect(body.paper_id).toBe(PAPER);
    expect(body.checked).toBe(true);
    expect(body.options).toEqual(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);
    expect(body.correct_idx).toBe(1);
    expect(body.teacher_explanation).toBe('Article 80.');
    // V9: a save NEVER sets a status. Only publish_paper() does.
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('id');

    expect(saved.checked).toBe(true);
  });

  it('patches an existing question by id, and still never sends a status', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow({ checked: true })]));
    const client = questions(fetchImpl as unknown as typeof fetch);

    await client.save({ ...EDIT, id: QUESTION });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toContain(`id=eq.${QUESTION}`);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('teacher_id');
  });

  it('throws a named QuestionConflict when that number is taken', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'duplicate key' }, 409));
    const client = questions(fetchImpl as unknown as typeof fetch);

    await expect(client.save(EDIT)).rejects.toMatchObject({ name: 'QuestionConflict' });
  });

  it('never echoes the Supabase body in the error it throws', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'policy questions_insert_own' }, 403));
    const client = questions(fetchImpl as unknown as typeof fetch);

    await expect(client.save(EDIT)).rejects.toThrow(/status 403/);
    await expect(client.save(EDIT)).rejects.not.toThrow(/questions_insert_own/);
  });

  it('throws when a PATCH changed no row, because RLS hid it', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = questions(fetchImpl as unknown as typeof fetch);
    await expect(client.save({ ...EDIT, id: QUESTION })).rejects.toThrow();
  });
});

describe('publishPaper', () => {
  function rpc(fetchImpl: typeof fetch) {
    return questions(fetchImpl);
  }

  it('calls the publish_paper function and returns the count', async () => {
    const fetchImpl = vi.fn(async () => json(3));
    const client = rpc(fetchImpl as unknown as typeof fetch);

    expect(await client.publishPaper(PAPER)).toBe(3);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/rpc/publish_paper');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ paper_id: PAPER });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer caller-token');
  });

  it('names the "still unchecked" refusal, so the route need not read Postgres', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ code: '23514', message: 'paper has 2 unchecked question(s)' }, 400),
    );
    const client = rpc(fetchImpl as unknown as typeof fetch);
    await expect(client.publishPaper(PAPER)).rejects.toMatchObject({
      name: 'PublishUnchecked',
    });
  });

  it('names the "split still running" refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ code: '55000', message: 'the split is still running' }, 400),
    );
    const client = rpc(fetchImpl as unknown as typeof fetch);
    await expect(client.publishPaper(PAPER)).rejects.toMatchObject({
      name: 'PublishSplitting',
    });
  });

  it('names the "not yours" and "not found" refusals the same way', async () => {
    for (const code of ['42501', 'P0002']) {
      const fetchImpl = vi.fn(async () => json({ code, message: 'no' }, 400));
      const client = rpc(fetchImpl as unknown as typeof fetch);
      await expect(client.publishPaper(PAPER)).rejects.toMatchObject({
        name: 'PublishForbidden',
      });
    }
  });

  it('refuses a paper id that is not a uuid, before firing anything', async () => {
    const fetchImpl = vi.fn(async () => json(1));
    const client = rpc(fetchImpl as unknown as typeof fetch);
    await expect(client.publishPaper('paper-1')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createSupabaseIngestJobsClient', () => {
  it('reports not configured with no env, and never fires a request', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = jobs(fetchImpl as unknown as typeof fetch, {});

    expect(client.isConfigured()).toBe(false);
    expect(await client.readLatestForPaper(PAPER)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queues a job owned by the session user, with no status in the body', async () => {
    const fetchImpl = vi.fn(async () => json([jobRow()]));
    const client = jobs(fetchImpl as unknown as typeof fetch);

    const job = await client.createQueued({ paperId: PAPER, pdfPath: 'papers/q.pdf' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/ingest_jobs');
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      teacher_id: TEACHER,
      paper_id: PAPER,
      pdf_path: 'papers/q.pdf',
    });

    expect(job).toEqual({
      id: '77777777-7777-4777-8777-777777777777',
      teacherId: TEACHER,
      paperId: PAPER,
      pdfPath: 'papers/q.pdf',
      status: 'queued',
      attempts: 0,
      error: null,
      questionCount: 0,
    });
  });

  it('throws when the queue insert fails, so the route can decide', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'no' }, 500));
    const client = jobs(fetchImpl as unknown as typeof fetch);
    await expect(
      client.createQueued({ paperId: PAPER, pdfPath: 'papers/q.pdf' }),
    ).rejects.toThrow(/status 500/);
  });

  it('reads the NEWEST job for a paper', async () => {
    const fetchImpl = vi.fn(async () => json([jobRow({ status: 'running' })]));
    const client = jobs(fetchImpl as unknown as typeof fetch);

    const job = await client.readLatestForPaper(PAPER);

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain(`paper_id=eq.${PAPER}`);
    expect(url).toContain('order=created_at.desc');
    expect(url).toContain('limit=1');
    expect(job?.status).toBe('running');
  });

  it('gives null, never a crash, when there is no job or Supabase says no', async () => {
    const empty = jobs(vi.fn(async () => json([])) as unknown as typeof fetch);
    expect(await empty.readLatestForPaper(PAPER)).toBeNull();

    const broken = jobs(vi.fn(async () => json({}, 500)) as unknown as typeof fetch);
    expect(await broken.readLatestForPaper(PAPER)).toBeNull();
  });
});
