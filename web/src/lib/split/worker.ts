/**
 * The P9 split worker, one job at a time (issue 12-pdf-split-worker).
 *
 * `runOnce` is the whole job: claim ONE queued row, load its PDF, ask the
 * model to cut it into questions, write them as unchecked drafts, mark the job
 * `done`. Three bad answers in a row mark it `failed` with the reason, which
 * the teacher reads on the review screen.
 *
 * It takes its three outside services as arguments and never builds them, so
 * the tests drive the whole path with fakes: no network, no key, no PDF
 * (web/CLAUDE.md). `web/jobs/pdf-split.ts` is the file that builds the real
 * ones.
 *
 * THE RULES IT KEEPS, all from design.md:
 *
 *  * D1/D2  1 job at a time. `runOnce` claims exactly one row and returns.
 *  * D4     Re-run safe. The job's OWN drafts are deleted before new ones are
 *           written, so pressing retry twice gives the same rows, not double.
 *  * F4     3 attempts, 200 questions. A failure that a retry cannot fix
 *           (missing PDF, 201 questions) is not retried at all.
 *  * Risk 1 Every row it writes is an unchecked draft. It never sets `live`,
 *           never sets `checked`, and never calls `publish_paper()`.
 *
 * WHAT IT NEVER DOES: log. The PDF is a teacher's property and the job row
 * carries ids; a `console.log` here would put both in a PM2 log file. The
 * return value is the report, and the caller decides what to do with it.
 */
import type { FileStore } from '@/lib/papers/types';
import type { IngestJob } from '@/lib/questions/types';
import {
  MAX_QUESTIONS_PER_PAPER,
  MAX_SPLIT_ATTEMPTS,
  isRetryable,
  readSplitAnswer,
  type QuestionSplitter,
  type SplitFailure,
  type SplitStore,
} from './types';

export { MAX_SPLIT_ATTEMPTS };

export interface SplitDeps {
  store: SplitStore;
  splitter: QuestionSplitter;
  files: FileStore;
}

/**
 * What one run did.
 *
 * `idle` covers both "nothing queued" and "we are not configured", because the
 * caller does the same thing with either: wait for the next trigger. Neither
 * is an error and neither touches a row.
 */
export type SplitOutcome =
  | { type: 'idle' }
  | { type: 'done'; jobId: string; questionCount: number; attempts: number }
  | { type: 'failed'; jobId: string; error: SplitFailure; attempts: number };

const IDLE: SplitOutcome = { type: 'idle' };

/**
 * Claim and finish ONE queued job, or report `idle`.
 *
 * Never throws for a bad model answer or a missing PDF: those are the job's
 * own failures and they are written to the row, which is the only place the
 * teacher can see them. It CAN throw if the store itself is unreachable, and
 * the runner that calls it treats that as "try again on the next tick" rather
 * than crashing the PM2 app.
 */
export async function runOnce({ store, splitter, files }: SplitDeps): Promise<SplitOutcome> {
  // Checked BEFORE claiming anything. A missing key must leave the queue
  // exactly as it was: failing a teacher's upload because an env var is unset
  // would throw away work that is perfectly fine.
  if (!store.isConfigured() || !splitter.isConfigured() || !files.isConfigured()) return IDLE;

  const job = await store.claimQueuedJob();
  if (!job) return IDLE;

  // `claimQueuedJob` already set attempts to 1, so try 1 needs no write.
  let attempts = 1;

  const pdf = await files.download(job.pdfPath);
  if (!pdf || pdf.byteLength === 0) {
    // Not retried: an object that is not in the bucket will not appear on the
    // third try, and the model is never asked, so nothing is spent.
    await store.failJob({ jobId: job.id, error: 'no-pdf' });
    return { type: 'failed', jobId: job.id, error: 'no-pdf', attempts };
  }

  // D4, BEFORE the first write and before the first model call: whatever this
  // job wrote on an earlier run is gone, so a retry cannot double the rows or
  // clash with `questions_paper_number_idx`.
  try {
    await store.deleteDraftsForJob(job.id);
  } catch {
    await store.failJob({ jobId: job.id, error: 'write-failed' });
    return { type: 'failed', jobId: job.id, error: 'write-failed', attempts };
  }

  let failure: SplitFailure = 'bad-answer';

  for (let attempt = 1; attempt <= MAX_SPLIT_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    if (attempt > 1) await store.setAttempts(job.id, attempt);

    const reading = await askOnce({ splitter, pdf });

    if (reading.ok) {
      // A refused row (a clashing question number, a constraint the model's
      // answer broke) must not leave the job on `running` for ever: the
      // teacher's screen would spin and the 5-minute sweep only looks at
      // `queued`. So a write error becomes a REPORTED failure.
      try {
        const count = await store.insertDrafts({ job, questions: reading.questions });
        await store.finishJob({ jobId: job.id, questionCount: count });
        return { type: 'done', jobId: job.id, questionCount: count, attempts };
      } catch {
        await store.failJob({ jobId: job.id, error: 'write-failed' });
        return { type: 'failed', jobId: job.id, error: 'write-failed', attempts };
      }
    }

    failure = reading.reason;
    // A deterministic refusal ends the run now. Three identical answers would
    // cost three calls and tell the teacher nothing new.
    if (!isRetryable(failure)) break;
  }

  await store.failJob({ jobId: job.id, error: failure });
  return { type: 'failed', jobId: job.id, error: failure, attempts };
}

/**
 * One model call, validated.
 *
 * A thrown error (a 500, a timeout, a dropped connection) becomes
 * `splitter-error`, which IS retryable, so a flaky network does not lose a
 * paper. The error object itself is dropped: it can quote a response body, and
 * a response body is untrusted text.
 */
async function askOnce({
  splitter,
  pdf,
}: {
  splitter: QuestionSplitter;
  pdf: Uint8Array;
}): Promise<ReturnType<typeof readSplitAnswer>> {
  let answer: unknown;
  try {
    answer = await splitter.split({ pdf, maxQuestions: MAX_QUESTIONS_PER_PAPER });
  } catch {
    return { ok: false, reason: 'splitter-error' };
  }
  return readSplitAnswer(answer);
}

/** True when the job is finished either way, so the runner can stop waiting. */
export function isSettled(job: IngestJob): boolean {
  return job.status === 'done' || job.status === 'failed';
}
