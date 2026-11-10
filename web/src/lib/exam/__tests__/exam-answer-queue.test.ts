/**
 * The exam answer queue (issue 58-exam-answer-queue).
 *
 * What it has to prove:
 *
 *  * A send that FAILS keeps the answer. A send that then SUCCEEDS clears it,
 *    oldest first, with no duplicate.
 *  * ONE ITEM PER QUESTION. A second tap on the same question replaces the
 *    held one and keeps its place in the line.
 *  * STOP AT THE FIRST FAILURE, so answer 4 does not spend the student's data
 *    while answer 3 is still stuck.
 *  * THE QUEUE SURVIVES A RELOAD. It is written to local storage and read back
 *    by the next queue over the same attempt.
 *  * THE PAGE WORKS WITH NO STORAGE AT ALL. A storage that throws on every
 *    call must not lose an answer and must not throw out of `push`.
 *  * ONLY the attempt, the question, the chosen option and the mark reach the
 *    phone. No stem and no options.
 *  * `stop()` ends the sending, which is what unmount calls (B6).
 *
 * No network and no key here: `save` is a fake (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createExamAnswerQueue,
  examQueueKey,
  readHeldAnswers,
  type QueueStorage,
} from '../exam-answer-queue';
import type { ExamAnswer } from '../types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const OTHER_ATTEMPT = '99999999-9999-4999-8999-999999999999';

const Q1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const Q2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const Q3 = 'aaaaaaaa-0000-4000-8000-000000000003';

function answer(questionId: string, chosenIdx: number | null, marked = false): ExamAnswer {
  return { attemptId: ATTEMPT, questionId, chosenIdx, marked };
}

/** A local storage that lives in a Map, so a test can read what was written. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage: QueueStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

/** A storage that is there but refuses everything, like Safari in private mode. */
const brokenStorage: QueueStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
  removeItem() {
    throw new Error('blocked');
  },
};

// --------------------------------------------------------------------------
// Fails, then succeeds
// --------------------------------------------------------------------------
describe('a bad network', () => {
  it('holds the answer that failed and sends it when the net comes back', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });

    await queue.push(answer(Q1, 0));
    await queue.push(answer(Q2, 1));

    expect(sent).toEqual([]);
    expect(queue.pending()).toBe(2);
    expect(queue.waiting()).toEqual([Q1, Q2]);

    up = true;
    expect(await queue.flush()).toBe(0);

    // In order, and each answer exactly once.
    expect(sent).toEqual([answer(Q1, 0), answer(Q2, 1)]);
    expect(queue.pending()).toBe(0);
  });

  it('stops at the first failure instead of spending data on the rest', async () => {
    const tried: string[] = [];
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        tried.push(one.questionId);
        throw new Error('offline');
      },
    });

    await queue.push(answer(Q1, 0));
    await queue.push(answer(Q2, 1));
    await queue.push(answer(Q3, 2));

    // One try per push, always the oldest. Never the whole line.
    expect(tried).toEqual([Q1, Q1, Q1]);
    expect(queue.pending()).toBe(3);
  });

  it('never throws out of push, so a dead network cannot take the paper down', async () => {
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async () => {
        throw new Error('offline');
      },
    });

    await expect(queue.push(answer(Q1, 0))).resolves.toBeUndefined();
    expect(await queue.flush()).toBe(1);
  });

  it('holds everything back while the browser says it is offline', async () => {
    const sent: ExamAnswer[] = [];
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      isOnline: () => false,
      save: async (one) => {
        sent.push(one);
      },
    });

    await queue.push(answer(Q1, 0));

    expect(sent).toEqual([]);
    expect(queue.pending()).toBe(1);
  });
});

// --------------------------------------------------------------------------
// One item per question
// --------------------------------------------------------------------------
describe('the same question answered twice', () => {
  it('keeps the LAST answer, in the FIRST answer place in the line', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });

    await queue.push(answer(Q1, 0));
    await queue.push(answer(Q2, 1));
    await queue.push(answer(Q1, 3));

    expect(queue.pending()).toBe(2);
    expect(queue.waiting()).toEqual([Q1, Q2]);

    up = true;
    await queue.flush();

    // The last tap on question 1 is what reached the server, and only once.
    expect(sent).toEqual([answer(Q1, 3), answer(Q2, 1)]);
  });

  it('sends nothing twice when two flushes run at the same time', async () => {
    const sent: ExamAnswer[] = [];
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        await new Promise((done) => setTimeout(done, 0));
        sent.push(one);
      },
    });

    await Promise.all([
      queue.push(answer(Q1, 0)),
      queue.push(answer(Q2, 1)),
      queue.flush(),
      queue.flush(),
    ]);

    expect(sent).toEqual([answer(Q1, 0), answer(Q2, 1)]);
    expect(queue.pending()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// The reload
// --------------------------------------------------------------------------
describe('local storage', () => {
  it('restores the held answers after a reload, in order', async () => {
    const { storage, map } = fakeStorage();
    const first = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async () => {
        throw new Error('offline');
      },
    });

    await first.push(answer(Q1, 0));
    await first.push(answer(Q2, 1));
    expect(map.get(examQueueKey(ATTEMPT))).toBeTruthy();

    // The tab is closed and opened again: a NEW queue over the same storage.
    const sent: ExamAnswer[] = [];
    const second = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        sent.push(one);
      },
    });

    expect(second.pending()).toBe(2);
    expect(second.waiting()).toEqual([Q1, Q2]);
    expect(await second.flush()).toBe(0);
    expect(sent).toEqual([answer(Q1, 0), answer(Q2, 1)]);
    // Nothing left behind for the next sitting to pick up.
    expect(map.get(examQueueKey(ATTEMPT))).toBeUndefined();
  });

  it('stores only the attempt, the question, the chosen option and the mark', async () => {
    const { storage, map } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async () => {
        throw new Error('offline');
      },
    });

    await queue.push({ ...answer(Q1, 2, true), stem: 'secret' } as ExamAnswer);

    const raw = map.get(examQueueKey(ATTEMPT)) ?? '';
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw)).toEqual([
      { attemptId: ATTEMPT, questionId: Q1, chosenIdx: 2, marked: true },
    ]);
  });

  it('ignores leftovers of another sitting and anything that is not an answer', () => {
    const held = JSON.stringify([
      answer(Q1, 0),
      { ...answer(Q2, 1), attemptId: OTHER_ATTEMPT },
      { questionId: 'not-a-uuid', chosenIdx: 0 },
      'rubbish',
      { ...answer(Q3, 9) },
    ]);

    expect(readHeldAnswers(held, ATTEMPT)).toEqual([answer(Q1, 0)]);
  });

  it('reads broken JSON as an empty queue', () => {
    expect(readHeldAnswers('{not json', ATTEMPT)).toEqual([]);
    expect(readHeldAnswers(null, ATTEMPT)).toEqual([]);
    expect(readHeldAnswers('{"a":1}', ATTEMPT)).toEqual([]);
  });

  it('works with no storage at all, keeping the answers in memory', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage: null,
      save: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });

    await queue.push(answer(Q1, 0));
    expect(queue.pending()).toBe(1);

    up = true;
    expect(await queue.flush()).toBe(0);
    expect(sent).toEqual([answer(Q1, 0)]);
  });

  it('works with a storage that throws on every single call', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage: brokenStorage,
      save: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });

    await expect(queue.push(answer(Q1, 0))).resolves.toBeUndefined();
    expect(queue.pending()).toBe(1);

    up = true;
    expect(await queue.flush()).toBe(0);
    expect(sent).toEqual([answer(Q1, 0)]);
  });
});

// --------------------------------------------------------------------------
// Telling the screen, and stopping
// --------------------------------------------------------------------------
describe('the screen', () => {
  it('tells its listeners every time the waiting list changes', async () => {
    const seen = vi.fn();
    let up = false;
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async () => {
        if (!up) throw new Error('offline');
      },
    });

    const off = queue.subscribe(seen);
    await queue.push(answer(Q1, 0));
    expect(seen).toHaveBeenCalled();

    seen.mockClear();
    up = true;
    await queue.flush();
    expect(seen).toHaveBeenCalled();

    off();
    seen.mockClear();
    await queue.push(answer(Q2, 1));
    expect(seen).not.toHaveBeenCalled();
  });

  it('sends nothing more once it is stopped, and keeps what it held', async () => {
    const sent: ExamAnswer[] = [];
    const { storage, map } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: async (one) => {
        sent.push(one);
        throw new Error('offline');
      },
    });

    await queue.push(answer(Q1, 0));
    sent.length = 0;
    queue.stop();

    await queue.push(answer(Q2, 1));
    expect(await queue.flush()).toBe(2);
    expect(sent).toEqual([]);
    // Still on the phone, so the next page load picks it up.
    expect(readHeldAnswers(map.get(examQueueKey(ATTEMPT)) ?? null, ATTEMPT)).toEqual([
      answer(Q1, 0),
      answer(Q2, 1),
    ]);
  });
});
