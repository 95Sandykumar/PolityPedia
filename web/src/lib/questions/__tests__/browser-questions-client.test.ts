/**
 * Browser-side questions client (issue 11-ingest-job-review-publish).
 *
 * `fetch` is injected, so there is no real network call in this test
 * (web/CLAUDE.md). What it has to prove: the client posts to OUR route, never
 * to Supabase, and every refusal comes back as one of our own short codes so
 * a Postgres message can never reach the page.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TEACHER_QUESTIONS_PATH,
  createBrowserQuestionsClient,
  paperPublishPath,
} from '../browser-questions-client';
import type { Question, QuestionEdit } from '../types';

const PAPER = '55555555-5555-4555-8555-555555555555';
const TEACHER = '44444444-4444-4444-8444-444444444444';

const EDIT: QuestionEdit = {
  id: null,
  paperId: PAPER,
  testId: null,
  number: 2,
  stem: 'Who appoints the Governor?',
  options: ['President', 'Prime Minister', 'Chief Minister', 'Speaker'],
  correctIdx: 0,
  teacherExplanation: 'Article 155.',
  lang: 'en',
  checked: true,
};

const STORED: Question = {
  id: '66666666-6666-4666-8666-666666666666',
  teacherId: TEACHER,
  paperId: PAPER,
  testId: null,
  number: 2,
  stem: 'Who appoints the Governor?',
  options: ['President', 'Prime Minister', 'Chief Minister', 'Speaker'],
  correctIdx: 0,
  teacherExplanation: 'Article 155.',
  topicId: null,
  lang: 'en',
  imagePath: null,
  checked: true,
  status: 'draft',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('paperPublishPath', () => {
  it('points at our own route and escapes the id', () => {
    expect(paperPublishPath(PAPER)).toBe(`/api/teacher/papers/${PAPER}/publish`);
    expect(paperPublishPath('a/b')).toBe('/api/teacher/papers/a%2Fb/publish');
  });
});

describe('save', () => {
  it('posts the edit as JSON to our own route', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, question: STORED }));
    const client = createBrowserQuestionsClient(fetchImpl as unknown as typeof fetch);

    expect(await client.save(EDIT)).toEqual(STORED);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TEACHER_QUESTIONS_PATH);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(EDIT);
  });

  it('turns 409 into our own duplicate-number code', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'duplicate number' }, 409));
    const client = createBrowserQuestionsClient(fetchImpl as unknown as typeof fetch);
    await expect(client.save(EDIT)).rejects.toThrow('duplicate-number');
  });

  it('never echoes the server message for any other failure', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'policy questions_insert_own' }, 502));
    const client = createBrowserQuestionsClient(fetchImpl as unknown as typeof fetch);

    await expect(client.save(EDIT)).rejects.toThrow('Request failed with status 502');
    await expect(client.save(EDIT)).rejects.not.toThrow(/questions_insert_own/);
  });

  it('fails when the reply carries no question, so the screen never says saved', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const client = createBrowserQuestionsClient(fetchImpl as unknown as typeof fetch);
    await expect(client.save(EDIT)).rejects.toThrow();
  });
});

describe('publish', () => {
  it('posts to the publish route and returns the count', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, published: 7 }));
    const client = createBrowserQuestionsClient(fetchImpl as unknown as typeof fetch);

    expect(await client.publish(PAPER)).toBe(7);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(paperPublishPath(PAPER));
    expect(init.method).toBe('POST');
  });

  it('tells the two 409s apart, because they need different lines', async () => {
    const unchecked = createBrowserQuestionsClient(
      vi.fn(async () => json({ error: 'unchecked' }, 409)) as unknown as typeof fetch,
    );
    await expect(unchecked.publish(PAPER)).rejects.toThrow('unchecked');

    const splitting = createBrowserQuestionsClient(
      vi.fn(async () => json({ error: 'splitting' }, 409)) as unknown as typeof fetch,
    );
    await expect(splitting.publish(PAPER)).rejects.toThrow('splitting');
  });

  it('reads a 409 with no body as "unchecked", which is the common one', async () => {
    const client = createBrowserQuestionsClient(
      vi.fn(async () => new Response('', { status: 409 })) as unknown as typeof fetch,
    );
    await expect(client.publish(PAPER)).rejects.toThrow('unchecked');
  });

  it('turns 404 into not-found', async () => {
    const client = createBrowserQuestionsClient(
      vi.fn(async () => json({ error: 'not found' }, 404)) as unknown as typeof fetch,
    );
    await expect(client.publish(PAPER)).rejects.toThrow('not-found');
  });

  it('reports the status for anything else', async () => {
    const client = createBrowserQuestionsClient(
      vi.fn(async () => json({ error: 'publish failed' }, 502)) as unknown as typeof fetch,
    );
    await expect(client.publish(PAPER)).rejects.toThrow('Request failed with status 502');
  });
});
