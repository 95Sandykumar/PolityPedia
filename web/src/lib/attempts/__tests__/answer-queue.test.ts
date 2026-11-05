/**
 * The offline retry queue (issue 13-question-player).
 *
 * DESIGN.md section 9: "Offline -- top banner 'No internet. Answers are saved
 * and sent when back.' The answer queue retries."
 *
 * The thing this file proves is the one the issue asks for: an answer given
 * with no network is kept, and it goes out when the network comes back. The
 * `save` here is a FAKE, so no test makes a network call (web/CLAUDE.md).
 *
 * A1 again, one layer up: two answers for the SAME question collapse into one
 * queued item, so a student who taps three times does not send three writes.
 * The database key makes a repeat harmless; this makes it rare.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAnswerQueue } from '../answer-queue';
import type { AnswerUpsert } from '../types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const Q1 = '22222222-2222-4222-8222-222222222221';
const Q2 = '22222222-2222-4222-8222-222222222222';

function answer(questionId: string, chosenIdx: number | null): AnswerUpsert {
  return {
    attemptId: ATTEMPT,
    questionId,
    chosenIdx,
    isCorrect: chosenIdx === 1,
    marked: false,
  };
}

/** A fake transport with a switch on it, standing in for the network. */
function fakeSave() {
  const sent: AnswerUpsert[] = [];
  let online = true;

  return {
    sent,
    goOffline() {
      online = false;
    },
    goOnline() {
      online = true;
    },
    isOnline: () => online,
    save: vi.fn(async (one: AnswerUpsert) => {
      // What a dead connection really looks like to `fetch`: a rejection.
      if (!online) throw new Error('offline');
      sent.push(one);
    }),
  };
}

describe('createAnswerQueue', () => {
  it('sends an answer straight away when the network is up', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save });

    await queue.push(answer(Q1, 1));

    expect(net.sent).toHaveLength(1);
    expect(queue.pending()).toBe(0);
  });

  // ------------------------------------------------------------------
  // The test the issue names: retries after reconnect.
  // ------------------------------------------------------------------
  it('keeps an answer while offline and sends it after reconnect', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save, isOnline: net.isOnline });

    net.goOffline();
    await queue.push(answer(Q1, 1));

    // Nothing left, and the student is told: the banner reads `pending() > 0`.
    expect(net.sent).toHaveLength(0);
    expect(queue.pending()).toBe(1);

    net.goOnline();
    await queue.flush();

    expect(net.sent).toEqual([answer(Q1, 1)]);
    expect(queue.pending()).toBe(0);
  });

  it('keeps an answer when the send itself fails, with no offline flag', async () => {
    // The nastier case: the browser still says "online" and the request dies
    // anyway. A dropping 4G cell does exactly this.
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save });

    net.goOffline();
    await queue.push(answer(Q1, 1));
    expect(queue.pending()).toBe(1);

    net.goOnline();
    await queue.flush();
    expect(queue.pending()).toBe(0);
    expect(net.sent).toHaveLength(1);
  });

  it('never throws out of push, whatever the transport does', async () => {
    const queue = createAnswerQueue({
      save: async () => {
        throw new Error('boom');
      },
    });

    // A rejected promise here would take the whole player down mid-paper.
    await expect(queue.push(answer(Q1, 1))).resolves.toBeUndefined();
    expect(queue.pending()).toBe(1);
  });

  it('collapses two answers for the same question into one write', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save, isOnline: net.isOnline });

    net.goOffline();
    await queue.push(answer(Q1, 0));
    await queue.push(answer(Q1, 1));
    expect(queue.pending()).toBe(1);

    net.goOnline();
    await queue.flush();

    // The LAST tap wins, because that is what the student can see on screen.
    expect(net.sent).toEqual([answer(Q1, 1)]);
  });

  it('keeps one item per question and sends them in order', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save, isOnline: net.isOnline });

    net.goOffline();
    await queue.push(answer(Q1, 1));
    await queue.push(answer(Q2, 0));
    await queue.push(answer(Q1, 2));
    expect(queue.pending()).toBe(2);

    net.goOnline();
    await queue.flush();

    expect(net.sent.map((one) => one.questionId)).toEqual([Q1, Q2]);
    expect(net.sent[0].chosenIdx).toBe(2);
  });

  it('stops at the first failure and keeps the rest in order', async () => {
    const sent: string[] = [];
    let allow = 1;
    const queue = createAnswerQueue({
      save: async (one) => {
        if (sent.length >= allow) throw new Error('offline again');
        sent.push(one.questionId);
      },
      isOnline: () => true,
    });

    // Both fail: `allow` is 0 sends past the first, which is already used.
    allow = 0;
    await queue.push(answer(Q1, 1));
    await queue.push(answer(Q2, 0));
    expect(queue.pending()).toBe(2);

    // Room for exactly one send. The second must stay queued, not be dropped.
    allow = 1;
    await queue.flush();
    expect(sent).toEqual([Q1]);
    expect(queue.pending()).toBe(1);

    allow = 2;
    await queue.flush();
    expect(sent).toEqual([Q1, Q2]);
    expect(queue.pending()).toBe(0);
  });

  it('tells its listeners whenever the waiting count changes', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save, isOnline: net.isOnline });
    const seen: number[] = [];
    const stop = queue.subscribe(() => seen.push(queue.pending()));

    net.goOffline();
    await queue.push(answer(Q1, 1));
    net.goOnline();
    await queue.flush();

    expect(seen).toContain(1);
    expect(seen[seen.length - 1]).toBe(0);

    stop();
    await queue.push(answer(Q2, 1));
    // Unsubscribed, so nothing new arrives.
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('a flush with nothing waiting touches the network at all', async () => {
    const net = fakeSave();
    const queue = createAnswerQueue({ save: net.save });

    await queue.flush();
    expect(net.save).not.toHaveBeenCalled();
  });

  it('does not send the same item twice when two flushes overlap', async () => {
    // A gate the test opens by hand, so the send is still in the air while the
    // second flush runs.
    let release = () => {};
    const inTheAir = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sent: string[] = [];
    const queue = createAnswerQueue({
      save: async (one) => {
        await inTheAir;
        sent.push(one.questionId);
      },
      isOnline: () => true,
    });

    const first = queue.push(answer(Q1, 1));
    // A second flush lands while the first send is still going: the `online`
    // event and a tap can happen in the same tick.
    const second = queue.flush();
    release();
    await Promise.all([first, second]);

    expect(sent).toEqual([Q1]);
  });
});
