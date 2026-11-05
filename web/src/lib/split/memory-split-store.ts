/**
 * In-memory SplitStore (issue 12-pdf-split-worker).
 *
 * The FAKE the worker tests run against, so no test touches Postgres, holds a
 * service-role key or opens a socket (web/CLAUDE.md). It is a real
 * implementation of the interface, not a mock: it keeps rows, enforces the
 * rules the SQL enforces (one question number per paper, 200 per paper, 3
 * attempts) and refuses the same things the database would.
 *
 * `claimQueuedJob` is the interesting one. Here it is a plain
 * read-then-write, because there is only one worker in a test; in Postgres the
 * same promise is kept by `claim_ingest_job()` in 0012, which does it in ONE
 * statement with `for update skip locked`. The interface is what both sides
 * agree on; the atomicity lives in the SQL and is tested in
 * `test/split-jobs.test.ts`.
 */
import { MAX_QUESTIONS_PER_PAPER, type IngestJob } from '@/lib/questions/types';
import { MAX_SPLIT_ATTEMPTS, type SplitDraft, type SplitStore } from './types';
import type { SplitFailure, SplitQuestion } from './types';

interface Seed {
  teacherId: string;
  paperId: string;
  pdfPath: string;
}

export interface MemorySplitStore extends SplitStore {
  /** Queue one job. Returns its id. Later seeds queue behind earlier ones. */
  seedQueued(seed: Seed): string;
  /** One job row, or undefined. */
  job(jobId: string): IngestJob | undefined;
  /** This job's drafts, in number order. */
  draftsForJob(jobId: string): SplitDraft[];
  /** Every draft in the store, so a test can prove nothing was orphaned. */
  allDrafts(): SplitDraft[];
  /** The teacher pressed retry: back to `queued`, attempts back to 0. */
  requeue(jobId: string): void;
  /** Make the next write fail once, to test the unhappy path. */
  failNextWrite(): void;
}

export function createMemorySplitStore(): MemorySplitStore {
  const jobs = new Map<string, IngestJob>();
  // Insertion order IS queue order, which is what `order by created_at` means
  // in the SQL. A Map keeps it.
  const drafts: SplitDraft[] = [];
  let nextId = 1;
  let failOnce = false;

  const id = (prefix: string) => `${prefix}-${String(nextId++).padStart(4, '0')}`;

  function stop() {
    if (failOnce) {
      failOnce = false;
      throw new Error('memory split store was told to fail');
    }
  }

  function need(jobId: string): IngestJob {
    const job = jobs.get(jobId);
    if (!job) throw new Error('memory split store has no job ' + jobId);
    return job;
  }

  return {
    isConfigured() {
      return true;
    },

    async claimQueuedJob() {
      stop();
      for (const job of jobs.values()) {
        if (job.status !== 'queued') continue;
        const claimed: IngestJob = { ...job, status: 'running', attempts: 1, error: null };
        jobs.set(job.id, claimed);
        return claimed;
      }
      return null;
    },

    async setAttempts(jobId: string, attempts: number) {
      stop();
      // The same range `ingest_jobs_attempts_check` allows.
      if (attempts < 0 || attempts > MAX_SPLIT_ATTEMPTS) {
        throw new Error('attempts out of range: ' + attempts);
      }
      jobs.set(jobId, { ...need(jobId), attempts });
    },

    async deleteDraftsForJob(jobId: string) {
      stop();
      let removed = 0;
      for (let i = drafts.length - 1; i >= 0; i -= 1) {
        if (drafts[i].jobId === jobId) {
          drafts.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },

    async insertDrafts({ job, questions }: { job: IngestJob; questions: readonly SplitQuestion[] }) {
      stop();
      if (questions.length > MAX_QUESTIONS_PER_PAPER) {
        throw new Error('too many questions for one paper');
      }

      questions.forEach((question, index) => {
        const number = index + 1;
        // `questions_paper_number_idx`: one question number per paper.
        const clash = drafts.some(
          (one) => one.paperId === job.paperId && one.number === number,
        );
        if (clash) throw new Error('question number ' + number + ' is taken');

        drafts.push({
          id: id('q'),
          jobId: job.id,
          teacherId: job.teacherId,
          paperId: job.paperId,
          number,
          stem: question.stem,
          options: question.options,
          correctIdx: question.correctIdx,
          teacherExplanation: question.explanation,
          // Risk 1: everything the AI wrote starts unchecked and draft.
          checked: false,
          status: 'draft',
        });
      });

      return questions.length;
    },

    async finishJob({ jobId, questionCount }: { jobId: string; questionCount: number }) {
      stop();
      jobs.set(jobId, { ...need(jobId), status: 'done', questionCount, error: null });
    },

    async failJob({ jobId, error }: { jobId: string; error: SplitFailure }) {
      stop();
      jobs.set(jobId, { ...need(jobId), status: 'failed', error });
    },

    seedQueued(seed: Seed) {
      const jobId = id('job');
      jobs.set(jobId, {
        id: jobId,
        teacherId: seed.teacherId,
        paperId: seed.paperId,
        pdfPath: seed.pdfPath,
        status: 'queued',
        attempts: 0,
        error: null,
        questionCount: 0,
      });
      return jobId;
    },

    job(jobId: string) {
      const found = jobs.get(jobId);
      return found ? { ...found } : undefined;
    },

    draftsForJob(jobId: string) {
      return drafts
        .filter((one) => one.jobId === jobId)
        .sort((a, b) => a.number - b.number)
        .map((one) => ({ ...one }));
    },

    allDrafts() {
      return drafts.map((one) => ({ ...one }));
    },

    requeue(jobId: string) {
      jobs.set(jobId, {
        ...need(jobId),
        status: 'queued',
        attempts: 0,
        error: null,
        questionCount: 0,
      });
    },

    failNextWrite() {
      failOnce = true;
    },
  };
}
