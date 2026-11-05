/**
 * The decision logic behind POST /api/teacher/papers and
 * GET /api/papers/<id>/download (issue 10-papers-upload-browse).
 *
 * Kept out of the route files so the tests can drive it directly, the same
 * split as `teacher-exams-route.ts` / its route.
 *
 * Order of checks: session, role, config, then the body, then the files. The
 * 30 MB cap is checked BEFORE a single byte is read, so a 31 MB upload costs
 * us nothing.
 *
 * WHO the paper belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to upload under teacher B's name. A
 * `status` in the body is ignored too: a new paper is always a draft, and
 * publish is issue 11 (PRD F-D3).
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `papers_insert_own` policy inside Postgres. Replies carry a fixed message,
 * so a policy name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { IngestJob, IngestJobsClient } from '@/lib/questions/types';
import {
  checkPdf,
  isPaperKind,
  MAX_PAPER_LABEL_LENGTH,
  MAX_PAPER_YEAR,
  MIN_PAPER_YEAR,
  paperPdfPath,
  type FileStore,
  type NewPaper,
  type Paper,
  type PaperDraft,
  type PaperKind,
  type PapersClient,
  type UploadFile,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreatePaperInput {
  /** The parsed form fields, or anything at all: they are validated here. */
  body: unknown;
  /** The two PDFs, either of which may be missing. */
  files: { questions?: UploadFile | null; solutions?: UploadFile | null };
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: PapersClient;
  store: FileStore;
  /**
   * Queues the questions PDF for the AI split
   * (issue 11-ingest-job-review-publish). Optional, so this handler still
   * works on its own: with no jobs client the paper is stored and nothing is
   * queued.
   */
  jobs?: IngestJobsClient;
  /** Injected in tests, so a stored path is predictable. */
  newId?: () => string;
}

export interface CreatePaperReply {
  status: number;
  body:
    | {
        ok: true;
        paper: Paper;
        /**
         * The queued split job. Absent when there was no questions PDF to
         * split, or when the queue insert failed.
         */
        job?: IngestJob;
      }
    | { error: string };
}

function fail(status: number, error: string): CreatePaperReply {
  return { status, body: { error } };
}

/** The four fields of a paper, or null when any of them is the wrong shape. */
function readDraft(body: unknown): PaperDraft | null {
  if (typeof body !== 'object' || body === null) return null;
  const { examId, year, month, label } = body as Record<string, unknown>;

  if (typeof examId !== 'string' || !UUID_RE.test(examId)) return null;

  if (typeof year !== 'number' || !Number.isInteger(year)) return null;
  if (year < MIN_PAPER_YEAR || year > MAX_PAPER_YEAR) return null;

  // Null is "year only", which is not the same as January.
  let cleanMonth: number | null = null;
  if (month !== null && month !== undefined) {
    if (typeof month !== 'number' || !Number.isInteger(month)) return null;
    if (month < 1 || month > 12) return null;
    cleanMonth = month;
  }

  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAPER_LABEL_LENGTH) return null;

  // Only these four fields are carried over. A `teacherId` or a `status` in
  // the body is dropped right here.
  return { examId, year, month: cleanMonth, label: trimmed };
}

export async function handleCreatePaper({
  body,
  files,
  session,
  client,
  store,
  jobs,
  newId = () => globalThis.crypto.randomUUID(),
}: CreatePaperInput): Promise<CreatePaperReply> {
  if (!session) return fail(401, 'sign in');
  // A student has no papers of their own: `papers.teacher_id` references
  // `teachers.user_id`, so Postgres would refuse it anyway.
  if (session.role === 'student') return fail(403, 'teachers only');
  if (!client.isConfigured() || !store.isConfigured()) return fail(503, 'not configured');

  const draft = readDraft(body);
  if (!draft) return fail(400, 'bad request');

  const picked: { kind: PaperKind; file: UploadFile }[] = [];
  if (files.questions) picked.push({ kind: 'questions', file: files.questions });
  if (files.solutions) picked.push({ kind: 'solutions', file: files.solutions });
  if (picked.length === 0) return fail(400, 'pdf required');

  // EVERY file is checked before ANY file is uploaded, so a good questions PDF
  // never lands next to a refused solutions PDF.
  for (const { file } of picked) {
    const problem = checkPdf(file);
    if (problem === 'too-big') return fail(413, 'too big');
    if (problem !== null) return fail(400, 'not a pdf');
  }

  // One id for the whole paper, so its two PDFs sit next to each other.
  const fileId = newId();
  const paths: Record<PaperKind, string | null> = { questions: null, solutions: null };

  try {
    for (const { kind, file } of picked) {
      const path = paperPdfPath(session.userId, kind, fileId);
      await store.upload({
        path,
        contentType: 'application/pdf',
        bytes: await file.bytes(),
      });
      paths[kind] = path;
    }
  } catch {
    // Fixed message: the thrown error may quote a storage policy.
    return fail(502, 'upload failed');
  }

  const paper: NewPaper = {
    ...draft,
    questionsPath: paths.questions,
    solutionsPath: paths.solutions,
  };

  try {
    const stored = await client.create(paper);

    // Issue 11: queue the QUESTIONS pdf for the AI split (V9). The solutions
    // PDF is an answer key, not a question paper, so there is nothing in it to
    // cut into questions.
    //
    // A failed queue is NOT a failed upload. The paper is stored and its PDF
    // downloads, so answering 502 here would make the teacher send 30 MB
    // again over a 4G connection that already dropped once. The review screen
    // then shows no job, and the teacher can add questions by hand.
    let job: IngestJob | undefined;
    if (jobs && jobs.isConfigured() && stored.questionsPath) {
      job = await jobs
        .createQueued({ paperId: stored.id, pdfPath: stored.questionsPath })
        .catch(() => undefined);
    }

    return { status: 200, body: job ? { ok: true, paper: stored, job } : { ok: true, paper: stored } };
  } catch (cause) {
    // The teacher already has that paper (the unique constraint in 0010).
    if ((cause as Error)?.name === 'PaperConflict') return fail(409, 'duplicate');
    return fail(502, 'save failed');
  }
}

export interface PaperDownloadInput {
  paperId: string;
  /** From the query string, so it is anything until it is checked. */
  kind: unknown;
  session: AuthSession | null;
  client: PapersClient;
  store: FileStore;
}

export interface PaperDownloadReply {
  status: number;
  /** Where to send the browser, on a 302. */
  url?: string;
  body?: { error: string };
}

/**
 * Turn a paper id into a short-lived download URL.
 *
 * A student only ever reaches a LIVE paper: RLS hides a draft, and the status
 * is checked here as well, so a teacher reading their own draft is the only
 * case that passes. 404, not 403, for everything missing: "this paper is a
 * draft" is not a student's business.
 */
export async function handlePaperDownload({
  paperId,
  kind,
  session,
  client,
  store,
}: PaperDownloadInput): Promise<PaperDownloadReply> {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  if (!isPaperKind(kind)) return { status: 400, body: { error: 'bad request' } };
  if (!client.isConfigured() || !store.isConfigured()) {
    return { status: 503, body: { error: 'not configured' } };
  }

  const paper = await client.readOne(paperId).catch(() => null);
  if (!paper) return { status: 404, body: { error: 'not found' } };
  if (paper.status !== 'live' && paper.teacherId !== session.userId) {
    return { status: 404, body: { error: 'not found' } };
  }

  const path = kind === 'questions' ? paper.questionsPath : paper.solutionsPath;
  if (!path) return { status: 404, body: { error: 'not found' } };

  const url = await store.signedUrl(path).catch(() => null);
  if (!url) return { status: 404, body: { error: 'not found' } };

  return { status: 302, url };
}
