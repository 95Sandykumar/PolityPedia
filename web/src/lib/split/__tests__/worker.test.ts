/**
 * The P9 split worker (issue 12-pdf-split-worker).
 *
 * This is the test the issue asks for, and every case in it runs with a FAKE
 * splitter: no real network call, no real key, no real PDF (web/CLAUDE.md).
 * The live check against Claude is ticket H3, not this suite.
 *
 *  * happy path          -> N drafts, `done`
 *  * bad answer twice    -> `done` with attempts 3
 *  * bad answer 3 times  -> `failed` with the reason
 *  * re-run              -> the same rows, no duplicates (D4)
 *  * 201 questions       -> `failed` with a clear error (F-D2)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '@/lib/papers/memory-file-store';
import { MAX_QUESTIONS_PER_PAPER } from '@/lib/questions/types';
import { createMemorySplitStore, type MemorySplitStore } from '../memory-split-store';
import { createMemorySplitter, type MemorySplitter } from '../memory-splitter';
import { MAX_SPLIT_ATTEMPTS, runOnce } from '../worker';

const TEACHER = '11111111-1111-4111-8111-111111111111';
const PAPER = '22222222-2222-4222-8222-222222222222';
const PDF_PATH = `${TEACHER}/abc-questions.pdf`;

/** One well-formed question out of the splitter. */
function answer(count: number) {
  return {
    questions: Array.from({ length: count }, (_, index) => ({
      stem: `Who is question ${index + 1}?`,
      options: ['President', 'Prime Minister', 'Governor', 'Speaker'],
      correct_idx: index % 4,
      explanation: index === 0 ? 'Article 52.' : null,
    })),
  };
}

let store: MemorySplitStore;
let splitter: MemorySplitter;
let files: MemoryFileStore;

/** Queue one job whose PDF really is in the (fake) bucket. */
async function queueOne(): Promise<string> {
  await files.upload({
    path: PDF_PATH,
    contentType: 'application/pdf',
    bytes: new Uint8Array([37, 80, 68, 70]), // "%PDF"
  });
  return store.seedQueued({ teacherId: TEACHER, paperId: PAPER, pdfPath: PDF_PATH });
}

beforeEach(() => {
  store = createMemorySplitStore();
  splitter = createMemorySplitter();
  files = createMemoryFileStore();
});

describe('runOnce', () => {
  it('does nothing when no job is queued', async () => {
    const outcome = await runOnce({ store, splitter, files });
    expect(outcome).toEqual({ type: 'idle' });
    expect(splitter.calls()).toBe(0);
  });

  it('writes one draft per question and finishes the job', async () => {
    const jobId = await queueOne();
    splitter.willAnswer(answer(3));

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({ type: 'done', jobId, questionCount: 3, attempts: 1 });

    const job = store.job(jobId);
    expect(job?.status).toBe('done');
    expect(job?.questionCount).toBe(3);
    expect(job?.error).toBeNull();

    const drafts = store.draftsForJob(jobId);
    expect(drafts).toHaveLength(3);
    // Numbered 1..N in the order the model returned them.
    expect(drafts.map((one) => one.number)).toEqual([1, 2, 3]);
    // Every draft is owned by the job's teacher, hangs on the job's paper, and
    // is an UNCHECKED DRAFT. Risk 1: nothing the AI wrote may be live.
    for (const draft of drafts) {
      expect(draft.teacherId).toBe(TEACHER);
      expect(draft.paperId).toBe(PAPER);
      expect(draft.jobId).toBe(jobId);
      expect(draft.checked).toBe(false);
      expect(draft.status).toBe('draft');
    }
    expect(drafts[0].stem).toBe('Who is question 1?');
    expect(drafts[0].options).toEqual(['President', 'Prime Minister', 'Governor', 'Speaker']);
    expect(drafts[0].correctIdx).toBe(0);
    expect(drafts[0].teacherExplanation).toBe('Article 52.');
    expect(drafts[1].teacherExplanation).toBeNull();
  });

  it('claims ONE job at a time, oldest first', async () => {
    const first = await queueOne();
    const second = store.seedQueued({
      teacherId: TEACHER,
      paperId: PAPER,
      pdfPath: PDF_PATH,
    });
    splitter.willAnswer(answer(1));

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome.type).toBe('done');
    expect(outcome.type === 'done' && outcome.jobId).toBe(first);
    // The second job is untouched, still waiting its turn.
    expect(store.job(second)?.status).toBe('queued');
    expect(store.job(second)?.attempts).toBe(0);
  });

  it('retries a bad answer and finishes on the third try', async () => {
    const jobId = await queueOne();
    splitter.willAnswer('not json at all');
    splitter.willAnswer({ questions: [{ stem: 'only three options', options: ['a', 'b', 'c'] }] });
    splitter.willAnswer(answer(2));

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({ type: 'done', jobId, questionCount: 2, attempts: 3 });
    expect(splitter.calls()).toBe(3);

    const job = store.job(jobId);
    expect(job?.status).toBe('done');
    expect(job?.attempts).toBe(MAX_SPLIT_ATTEMPTS);
    expect(job?.error).toBeNull();
    expect(store.draftsForJob(jobId)).toHaveLength(2);
  });

  it('fails with the reason after three bad answers', async () => {
    const jobId = await queueOne();
    splitter.willAnswer('nope');
    splitter.willAnswer('nope');
    splitter.willAnswer('nope');

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({
      type: 'failed',
      jobId,
      error: 'bad-answer',
      attempts: MAX_SPLIT_ATTEMPTS,
    });
    expect(splitter.calls()).toBe(MAX_SPLIT_ATTEMPTS);

    const job = store.job(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(MAX_SPLIT_ATTEMPTS);
    expect(job?.error).toBe('bad-answer');
    // A failed split leaves NO half-written questions behind.
    expect(store.draftsForJob(jobId)).toHaveLength(0);
  });

  it('retries a splitter that throws, then gives up', async () => {
    const jobId = await queueOne();
    splitter.willThrow();
    splitter.willThrow();
    splitter.willThrow();

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({
      type: 'failed',
      jobId,
      error: 'splitter-error',
      attempts: MAX_SPLIT_ATTEMPTS,
    });
    expect(store.job(jobId)?.error).toBe('splitter-error');
  });

  it('re-running a job gives the same rows, never duplicates (D4)', async () => {
    const jobId = await queueOne();
    splitter.willAnswer(answer(3));
    await runOnce({ store, splitter, files });

    const firstIds = store.draftsForJob(jobId).map((one) => one.id);
    expect(firstIds).toHaveLength(3);

    // The teacher presses retry: the row goes back to `queued`.
    store.requeue(jobId);
    splitter.willAnswer(answer(3));
    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({ type: 'done', jobId, questionCount: 3, attempts: 1 });

    const second = store.draftsForJob(jobId);
    expect(second).toHaveLength(3);
    expect(second.map((one) => one.number)).toEqual([1, 2, 3]);
    expect(second.map((one) => one.stem)).toEqual(firstIds.map((_, i) => `Who is question ${i + 1}?`));
    // The OLD rows are gone, so the numbers cannot clash and the teacher does
    // not review the same question twice.
    expect(store.allDrafts()).toHaveLength(3);
    expect(second.some((one) => firstIds.includes(one.id))).toBe(false);
  });

  it('fails with a clear error when the split returns 201 questions', async () => {
    const jobId = await queueOne();
    splitter.willAnswer(answer(MAX_QUESTIONS_PER_PAPER + 1));

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({ type: 'failed', jobId, error: 'too-many', attempts: 1 });
    // Not retried: the same PDF would give the same count three times over.
    expect(splitter.calls()).toBe(1);

    const job = store.job(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('too-many');
    expect(store.draftsForJob(jobId)).toHaveLength(0);
  });

  it('accepts exactly 200 questions', async () => {
    const jobId = await queueOne();
    splitter.willAnswer(answer(MAX_QUESTIONS_PER_PAPER));

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({
      type: 'done',
      jobId,
      questionCount: MAX_QUESTIONS_PER_PAPER,
      attempts: 1,
    });
    expect(store.job(jobId)?.questionCount).toBe(MAX_QUESTIONS_PER_PAPER);
  });

  it('fails without calling the model when the PDF is gone', async () => {
    const jobId = store.seedQueued({
      teacherId: TEACHER,
      paperId: PAPER,
      pdfPath: PDF_PATH,
    });

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({ type: 'failed', jobId, error: 'no-pdf', attempts: 1 });
    // A missing object will still be missing on the third try, so the model is
    // never asked and no money is spent.
    expect(splitter.calls()).toBe(0);
    expect(store.job(jobId)?.error).toBe('no-pdf');
  });

  it('fails when the split finds no questions at all', async () => {
    const jobId = await queueOne();
    splitter.willAnswer({ questions: [] });
    splitter.willAnswer({ questions: [] });
    splitter.willAnswer({ questions: [] });

    const outcome = await runOnce({ store, splitter, files });

    expect(outcome).toEqual({
      type: 'failed',
      jobId,
      error: 'no-questions',
      attempts: MAX_SPLIT_ATTEMPTS,
    });
  });

  it('never sends the PDF anywhere when the splitter is not configured', async () => {
    const jobId = await queueOne();
    splitter.setConfigured(false);

    const outcome = await runOnce({ store, splitter, files });

    // The job stays QUEUED, so it is still there once the key is set. Failing
    // it would throw away a teacher's upload over a missing env var.
    expect(outcome).toEqual({ type: 'idle' });
    expect(store.job(jobId)?.status).toBe('queued');
    expect(store.job(jobId)?.attempts).toBe(0);
    expect(splitter.calls()).toBe(0);
  });
});
