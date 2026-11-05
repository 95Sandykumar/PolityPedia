/**
 * The offline answer queue (issue 13-question-player).
 *
 * DESIGN.md section 9: "Offline -- top banner 'No internet. Answers are saved
 * and sent when back.' The answer queue retries."
 *
 * A student on a train loses the cell for forty seconds. Those forty seconds
 * must not cost them their answers, so every answer goes in here first, the
 * send is tried at once, and anything that fails waits for the next `online`
 * event or the next answer.
 *
 * TWO RULES, BOTH SMALL AND BOTH LOAD-BEARING:
 *
 *  1. ONE ITEM PER QUESTION. A second answer to the same question REPLACES the
 *     queued one and keeps its place in the line. The last tap is what the
 *     student can see on screen, so it is the one that must reach the server.
 *     The database key makes a repeated write harmless (A1); this makes it rare.
 *  2. STOP AT THE FIRST FAILURE. The connection is one thing: if answer 3
 *     cannot go, answer 4 cannot either, and trying anyway would spend the
 *     student's data and could land the two out of order.
 *
 * `push` NEVER throws. A rejected promise here would take the whole player
 * down in the middle of a paper, and a lost answer is better handled by
 * waiting than by a blank screen.
 *
 * In-memory only in v1. A closed tab loses what is still waiting, which is why
 * the banner keeps saying so while `pending()` is above zero. Writing the
 * queue to IndexedDB is a later issue, not this slice.
 */
import type { AnswerQueue, AnswerUpsert } from './types';

export interface AnswerQueueOptions {
  /** The transport. `BrowserAttemptsClient.saveAnswer` in the app, a fake in tests. */
  save(answer: AnswerUpsert): Promise<void>;
  /**
   * Whether it is worth trying at all. `navigator.onLine` in the app.
   * Defaults to "always try": a wrong `false` would hold answers back for no
   * reason, and a failed send costs one request.
   */
  isOnline?(): boolean;
}

export function createAnswerQueue({ save, isOnline }: AnswerQueueOptions): AnswerQueue {
  /** Waiting answers, oldest first, at most one per question. */
  const waiting: AnswerUpsert[] = [];
  const listeners = new Set<() => void>();
  /** True while a flush is in the air, so two flushes never send one item twice. */
  let sending = false;

  function announce(): void {
    for (const listener of listeners) listener();
  }

  function queue(answer: AnswerUpsert): void {
    const at = waiting.findIndex((one) => one.questionId === answer.questionId);
    // Replace in place, so the order the student answered in is kept.
    if (at >= 0) waiting[at] = answer;
    else waiting.push(answer);
  }

  async function drain(): Promise<void> {
    if (sending) return;
    if (waiting.length === 0) return;
    if (isOnline && !isOnline()) return;

    sending = true;
    try {
      while (waiting.length > 0) {
        const next = waiting[0];
        try {
          await save(next);
        } catch {
          // Rule 2: the connection is one thing. Leave this item and the rest
          // of the line alone and wait for the next trigger.
          return;
        }
        // Found by identity, not by index: a tap during the await may have
        // replaced this very item, and that newer answer must not be dropped.
        const at = waiting.indexOf(next);
        if (at >= 0) waiting.splice(at, 1);
      }
    } finally {
      sending = false;
      announce();
    }
  }

  return {
    async push(answer: AnswerUpsert): Promise<void> {
      queue(answer);
      announce();
      await drain();
    },

    async flush(): Promise<void> {
      await drain();
    },

    pending(): number {
      return waiting.length;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
