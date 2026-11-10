/**
 * The exam answer queue (issue 58-exam-answer-queue).
 *
 * A student sits a timed paper on a phone on a train. The cell drops for forty
 * seconds. Before this file, `ExamPlayer` fired one `fetch` per tap and threw
 * the failure away, so those forty seconds looked perfectly normal on screen
 * and cost the student every answer they gave inside them. The score then came
 * back lower than the paper they had actually sat, with no warning anywhere.
 *
 * So every exam answer goes in HERE first. The send is tried at once, and
 * anything that fails waits for the next trigger: the `online` event, the next
 * tap, the 10 second retry, or Submit.
 *
 * THE RULES, ALL SMALL AND ALL LOAD-BEARING:
 *
 *  1. ONE ITEM PER QUESTION. A second answer to the same question REPLACES the
 *     held one and keeps its place in the line. What is on screen is what must
 *     reach the server. `attempt_answers_pkey` makes a repeat write harmless
 *     (A1); this makes it rare.
 *  2. STOP AT THE FIRST FAILURE. The connection is one thing: if answer 3
 *     cannot go, answer 4 cannot either, and trying anyway spends the
 *     student's data and could land the two out of order.
 *  3. `push` NEVER THROWS. A rejected promise here would take the paper down
 *     mid-sitting, and a held answer is better than a blank screen.
 *  4. `flush` RETURNS HOW MANY ARE STILL HELD. Submit reads that number: a
 *     paper closed with answers still on the phone would be marked on fewer
 *     answers than the student gave, so Submit refuses and says how many.
 *  5. THE SENDS ARE SERIALISED. Two flushes at once (Submit landing on top of
 *     the 10 second retry) must never send one answer twice.
 *
 * WHAT IS WRITTEN TO THE PHONE, and nothing else: the attempt id, the question
 * id, the chosen option and the mark flag. No stem, no options, no name. A
 * stolen phone yields four ids and a number. The mark flag is in because one
 * row carries both columns, so leaving it out would silently un-mark a
 * question that the student had marked and then re-answered offline.
 *
 * EVERY STORAGE CALL IS WRAPPED. Safari in private mode hands over a
 * `localStorage` object that throws on write, and a full quota throws too. A
 * phone where storage is dead still gets the in-memory queue, which is the
 * whole of the old behaviour plus the retries; it just loses what is held if
 * the tab is closed. Storage is the bonus, never the mechanism.
 *
 * THE SERVER IS STILL THE GATE. `attempt_answers_insert_open` and
 * `attempt_answers_update_open` in `0018_exam_mode.sql` refuse an answer after
 * the deadline, so a queue that comes back to life at 00:05 writes nothing.
 * This file makes a late answer FAIL HONESTLY; it never makes one legal.
 */
import { readExamAnswer, type ExamAnswer, type ExamAnswerQueue } from './types';

/** One key per sitting, so two papers in two tabs never read each other. */
export const EXAM_QUEUE_PREFIX = 'polity.exam.queue.';

export function examQueueKey(attemptId: string): string {
  return EXAM_QUEUE_PREFIX + attemptId;
}

/**
 * The slice of `localStorage` this file uses. An interface, so a test drives
 * the queue with a Map and with a storage that throws, and neither needs jsdom
 * to cooperate.
 */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What we are allowed to keep on the phone, built by LISTING the fields.
 *
 * A list fails safe: a field added to `ExamAnswer` next month is absent here
 * until somebody adds it on purpose, so the stem or an explanation cannot
 * arrive on a student's disk by accident.
 */
function held(answer: ExamAnswer): ExamAnswer {
  return {
    attemptId: answer.attemptId,
    questionId: answer.questionId,
    chosenIdx: answer.chosenIdx,
    marked: answer.marked === true,
  };
}

/**
 * Read a stored queue back, oldest first, at most one item per question.
 *
 * EVERY item goes through `readExamAnswer`, the same validator the route uses,
 * so a hand-edited `localStorage` cannot post a chosen index of 99 or a
 * question id that is not a UUID. An item belonging to ANOTHER attempt is
 * dropped: leftovers of yesterday's sitting must not be written into today's.
 *
 * Anything unreadable reads as an empty queue. A student with a corrupt entry
 * gets a working paper, never a crash on page load.
 */
export function readHeldAnswers(raw: string | null, attemptId: string): ExamAnswer[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExamAnswer[] = [];
  for (const one of parsed) {
    const answer = readExamAnswer(one);
    if (!answer) continue;
    if (answer.attemptId !== attemptId) continue;
    const at = out.findIndex((kept) => kept.questionId === answer.questionId);
    if (at >= 0) out[at] = answer;
    else out.push(answer);
  }
  return out;
}

/**
 * `window.localStorage`, or null when it is not there or not usable.
 *
 * PROBED WITH A REAL WRITE, because the broken cases all pass a `typeof`
 * check: Safari in private mode and a full quota both hand over the object and
 * throw on `setItem`. Finding that out here is one write; finding it out later
 * is a try/catch on the student's twelfth answer.
 */
function defaultStorage(): QueueStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const store = window.localStorage;
    const probe = EXAM_QUEUE_PREFIX + 'probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export interface ExamAnswerQueueOptions {
  /** The sitting these answers belong to. Also the storage key. */
  attemptId: string;
  /** The transport. `BrowserExamClient.saveAnswer` in the app, a fake in tests. */
  save(answer: ExamAnswer): Promise<void>;
  /**
   * Whether it is worth trying at all. `navigator.onLine` in the app.
   * Defaults to "always try": a wrong `false` would hold answers back for no
   * reason, and a failed send costs one request.
   */
  isOnline?(): boolean;
  /**
   * Where the queue is kept across a reload. Defaults to `window.localStorage`
   * when it is usable. Pass `null` for memory only.
   */
  storage?: QueueStorage | null;
}

export function createExamAnswerQueue({
  attemptId,
  save,
  isOnline,
  storage,
}: ExamAnswerQueueOptions): ExamAnswerQueue {
  const key = examQueueKey(attemptId);
  // `undefined` means "work it out", `null` means "memory only" on purpose:
  // a test that wants no storage must not get the browser's.
  const store = storage === undefined ? defaultStorage() : storage;

  const listeners = new Set<() => void>();
  /** Held answers, oldest first, at most one per question. */
  const waitingList: ExamAnswer[] = restore();
  /** The send in the air, so two flushes never send one answer twice. */
  let inFlight: Promise<number> | null = null;
  /** Set by `stop()` on unmount (B6). Storage is left alone on purpose. */
  let stopped = false;

  function restore(): ExamAnswer[] {
    try {
      return readHeldAnswers(store ? store.getItem(key) : null, attemptId);
    } catch {
      return [];
    }
  }

  function persist(): void {
    if (!store) return;
    try {
      if (waitingList.length === 0) store.removeItem(key);
      else store.setItem(key, JSON.stringify(waitingList));
    } catch {
      // A blocked or full store must not stop the paper. The queue carries on
      // in memory, and the banner keeps saying answers are still waiting.
    }
  }

  function announce(): void {
    for (const listener of listeners) listener();
  }

  function queue(answer: ExamAnswer): void {
    const at = waitingList.findIndex((one) => one.questionId === answer.questionId);
    // Replace IN PLACE, so the order the student answered in is kept (rule 1).
    if (at >= 0) waitingList[at] = answer;
    else waitingList.push(answer);
  }

  /** Send the line, oldest first. Returns how many are still held. */
  async function sendAll(): Promise<number> {
    if (stopped) return waitingList.length;
    if (waitingList.length === 0) return 0;
    if (isOnline && !isOnline()) return waitingList.length;

    while (waitingList.length > 0) {
      if (stopped) break;
      const next = waitingList[0];
      try {
        await save(next);
      } catch {
        // Rule 2: the connection is one thing. Leave this item and the rest of
        // the line alone and wait for the next trigger.
        break;
      }
      // Found by IDENTITY, not by index: a tap during the await may have
      // replaced this very item, and that newer answer must not be dropped.
      const at = waitingList.indexOf(next);
      if (at >= 0) waitingList.splice(at, 1);
      persist();
      announce();
    }
    return waitingList.length;
  }

  /**
   * One send at a time (rule 5).
   *
   * When nothing is in the air the send starts SYNCHRONOUSLY, up to its first
   * `await`, so a tap costs no extra tick before `save` is called. When a send
   * is already running this one waits for it and then has its own go, which is
   * what makes Submit's count the real one rather than a stale read of a flush
   * that was already half done.
   */
  function drain(): Promise<number> {
    // NOTHING TO SEND: answer at once and take no lock. Without this the flush
    // the player fires on mount (over an empty queue) would hold the lock for
    // a microtask, and the student's first tap would queue behind it instead
    // of going out in the same tick.
    if (stopped || waitingList.length === 0) return Promise.resolve(waitingList.length);

    const running = inFlight;
    if (running) return running.then(drain, drain);

    const run = (async () => {
      try {
        return await sendAll();
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  return {
    async push(answer: ExamAnswer): Promise<void> {
      queue(held(answer));
      persist();
      announce();
      // Rule 3: `drain` never rejects, so this never throws.
      await drain();
    },

    flush(): Promise<number> {
      return drain();
    },

    pending(): number {
      return waitingList.length;
    },

    waiting(): readonly string[] {
      return waitingList.map((one) => one.questionId);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    stop(): void {
      stopped = true;
    },
  };
}
