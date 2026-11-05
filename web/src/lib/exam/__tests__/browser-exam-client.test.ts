/**
 * The browser-side exam client (issue 18-exam-mode).
 *
 * `fetch` is injected, so there is no real network call and no key here
 * (web/CLAUDE.md). The real client carries no key either: it posts to our own
 * routes and the httpOnly session cookie does the rest.
 *
 * What it has to prove:
 *
 *  * THE SCORE COMES BACK FROM THE SERVER, including 0 and a negative number,
 *    which are both real under negative marking.
 *  * `saveAnswer` THROWS on a refusal, because the player decides what to do
 *    with a failure and can only do that if it is told.
 *  * `load` fails SOFT, because a failed review re-read must not take the
 *    score off the screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrowserExamClient } from '../browser-exam-client';

const TEST = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = '55555555-5555-4555-8555-555555555555';
const QUESTION = '66666666-6666-4666-8666-666666666666';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0) {
  const [path, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return {
    path,
    init,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
  };
}

describe('saveAnswer', () => {
  it('posts the answer to this test s own route', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));

    await createBrowserExamClient({
      testId: TEST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).saveAnswer({ attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2, marked: false });

    const { path, init, body } = call(fetchImpl);
    expect(path).toBe(`/api/tests/${TEST}/answer`);
    expect(init.method).toBe('POST');
    expect(body).toEqual({
      attemptId: ATTEMPT,
      questionId: QUESTION,
      chosenIdx: 2,
      marked: false,
    });
  });

  it('throws on a refusal, which is how an answer after the deadline reads', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'save failed' }, 502));

    await expect(
      createBrowserExamClient({
        testId: TEST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).saveAnswer({ attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 0, marked: false }),
    ).rejects.toThrow(/502/);
  });
});

describe('submit', () => {
  it('hands back the score the route replied with', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, score: 35 }));

    const score = await createBrowserExamClient({
      testId: TEST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).submit(ATTEMPT);

    expect(score).toBe(35);
    expect(call(fetchImpl).path).toBe(`/api/tests/${TEST}/submit`);
    expect(call(fetchImpl).body).toEqual({ attemptId: ATTEMPT });
  });

  it('keeps a score of zero and a negative score, which are both real', async () => {
    for (const score of [0, -3]) {
      const fetchImpl = vi.fn(async () => json({ ok: true, score }));

      expect(
        await createBrowserExamClient({
          testId: TEST,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }).submit(ATTEMPT),
      ).toBe(score);
    }
  });

  it('is null when the reply carries no number, never a made-up zero', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));

    expect(
      await createBrowserExamClient({
        testId: TEST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).submit(ATTEMPT),
    ).toBeNull();
  });

  it('throws when the route refuses, so the player can say so', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'submit failed' }, 502));

    await expect(
      createBrowserExamClient({
        testId: TEST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).submit(ATTEMPT),
    ).rejects.toThrow(/502/);
  });
});

describe('load', () => {
  it('reads the same list back, topic and all', async () => {
    const fetchImpl = vi.fn(async () => json({ revealed: true, questions: [] }));

    await createBrowserExamClient({
      testId: TEST,
      topicId: TOPIC,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).load();

    const { path, init } = call(fetchImpl);
    expect(path).toBe(`/api/tests/${TEST}/load?mode=exam&topic=${TOPIC}`);
    expect(init.method).toBe('GET');
  });

  it('fails SOFT, so a failed review re-read does not clear the score', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'load failed' }, 502));

    expect(
      await createBrowserExamClient({
        testId: TEST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).load(),
    ).toBeNull();
  });
});
