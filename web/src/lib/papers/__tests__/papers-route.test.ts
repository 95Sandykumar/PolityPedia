/**
 * POST /api/teacher/papers and GET /api/papers/<id>/download decision logic
 * (issue 10-papers-upload-browse).
 *
 * The row owner is NEVER in the body: it comes from the session cookie, so
 * there is no field a caller could set to upload under teacher B's name. This
 * is defence in depth; the gate is the `papers_*_own` policies inside Postgres
 * (0010).
 *
 * The papers client and the file store are fakes here: no real network call,
 * no real key and no real file in any test (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { createMemoryFileStore } from '../memory-file-store';
import { handleCreatePaper, handlePaperDownload } from '../papers-route';
import { MAX_PDF_BYTES, type Paper, type PapersClient, type UploadFile } from '../types';

const NET = 'a4000001-0000-4000-8000-000000000001';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER_ID = '99999999-9999-4999-8999-999999999999';

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    userId: TEACHER,
    role: 'teacher',
    teacherStatus: 'approved',
    ...overrides,
  };
}

function storedPaper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: PAPER_ID,
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
    ...overrides,
  };
}

function fakeClient(overrides: Partial<PapersClient> = {}): PapersClient {
  return {
    isConfigured: () => true,
    listMine: vi.fn(async () => []),
    listLiveForTeacher: vi.fn(async () => []),
    readOne: vi.fn(async () => null),
    create: vi.fn(async (draft) => storedPaper({ ...draft, status: 'draft' })),
    ...overrides,
  };
}

/** A PDF that never touches the disk: the bytes are made on demand. */
function pdf(size = 1024, name = 'net-2024.pdf', type = 'application/pdf'): UploadFile {
  return { name, type, size, bytes: async () => new Uint8Array(Math.min(size, 16)) };
}

const BODY = { examId: NET, year: 2024, month: 6, label: 'Shift 1' };

function create(overrides: Record<string, unknown> = {}) {
  return handleCreatePaper({
    body: BODY,
    files: { questions: pdf(), solutions: null },
    session: session(),
    client: fakeClient(),
    store: createMemoryFileStore(),
    newId: () => 'fixed-id',
    ...overrides,
  });
}

describe('handleCreatePaper', () => {
  it('uploads the PDF and saves a DRAFT row owned by the caller', async () => {
    const client = fakeClient();
    const store = createMemoryFileStore();

    const reply = await create({ client, store });

    expect(reply.status).toBe(200);
    expect(client.create).toHaveBeenCalledWith({
      examId: NET,
      year: 2024,
      month: 6,
      label: 'Shift 1',
      questionsPath: `${TEACHER}/fixed-id-questions.pdf`,
      solutionsPath: null,
    });
    expect(store.paths()).toEqual([`${TEACHER}/fixed-id-questions.pdf`]);
    expect(reply.body).toMatchObject({ ok: true });
  });

  it('takes both PDFs at once', async () => {
    const client = fakeClient();
    const store = createMemoryFileStore();

    const reply = await create({
      client,
      store,
      files: { questions: pdf(), solutions: pdf(2048, 'answers.pdf') },
    });

    expect(reply.status).toBe(200);
    expect(store.paths()).toEqual([
      `${TEACHER}/fixed-id-questions.pdf`,
      `${TEACHER}/fixed-id-solutions.pdf`,
    ]);
  });

  it('takes a solutions-only paper', async () => {
    const client = fakeClient();
    const reply = await create({ client, files: { questions: null, solutions: pdf() } });

    expect(reply.status).toBe(200);
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ questionsPath: null }),
    );
  });

  it('takes a paper with no month, which means the month is not known', async () => {
    const client = fakeClient();
    const reply = await create({ client, body: { ...BODY, month: null } });

    expect(reply.status).toBe(200);
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ month: null }));
  });

  it('refuses a 31 MB PDF and never uploads a byte', async () => {
    const client = fakeClient();
    const store = createMemoryFileStore();

    const reply = await create({
      client,
      store,
      files: { questions: pdf(31 * 1024 * 1024), solutions: null },
    });

    expect(reply.status).toBe(413);
    expect(reply.body).toEqual({ error: 'too big' });
    expect(store.paths()).toEqual([]);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('refuses a 31 MB second PDF as well, so neither file lands', async () => {
    const client = fakeClient();
    const store = createMemoryFileStore();

    const reply = await create({
      client,
      store,
      files: { questions: pdf(), solutions: pdf(31 * 1024 * 1024, 'big.pdf') },
    });

    expect(reply.status).toBe(413);
    expect(store.paths()).toEqual([]);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('accepts a PDF right on the 30 MB line', async () => {
    const reply = await create({ files: { questions: pdf(MAX_PDF_BYTES), solutions: null } });
    expect(reply.status).toBe(200);
  });

  it('refuses a file that is not a PDF', async () => {
    const store = createMemoryFileStore();
    const reply = await create({
      store,
      files: { questions: pdf(1000, 'scan.jpg', 'image/jpeg'), solutions: null },
    });

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'not a pdf' });
    expect(store.paths()).toEqual([]);
  });

  it('refuses an upload with no PDF at all', async () => {
    const client = fakeClient();
    const reply = await create({ client, files: { questions: null, solutions: null } });

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'pdf required' });
    expect(client.create).not.toHaveBeenCalled();
  });

  it('answers 401 with no session and never uploads', async () => {
    const store = createMemoryFileStore();
    const reply = await create({ session: null, store });

    expect(reply.status).toBe(401);
    expect(store.paths()).toEqual([]);
  });

  it('answers 403 for a student', async () => {
    const reply = await create({ session: session({ role: 'student' }) });
    expect(reply.status).toBe(403);
  });

  it('answers 503 when Supabase is not set up', async () => {
    const reply = await create({ client: fakeClient({ isConfigured: () => false }) });
    expect(reply.status).toBe(503);
  });

  it('ignores a teacher_id in the body: the owner comes from the session', async () => {
    const client = fakeClient();
    const reply = await create({
      client,
      body: { ...BODY, teacherId: '11111111-1111-4111-8111-111111111111' },
    });

    expect(reply.status).toBe(200);
    expect(client.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ teacherId: expect.anything() }),
    );
  });

  it('ignores a status in the body, so nothing goes live before publish', async () => {
    const client = fakeClient();
    const reply = await create({ client, body: { ...BODY, status: 'live' } });

    expect(reply.status).toBe(200);
    expect(client.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: expect.anything() }),
    );
  });

  it.each([
    ['no exam', { ...BODY, examId: 'not-a-uuid' }],
    ['no year', { ...BODY, year: null }],
    ['a year before papers existed', { ...BODY, year: 1200 }],
    ['a month of 13', { ...BODY, month: 13 }],
    ['a month of 0', { ...BODY, month: 0 }],
    ['a blank label', { ...BODY, label: '   ' }],
    ['a label of 300 characters', { ...BODY, label: 'x'.repeat(300) }],
    ['no body at all', null],
  ])('answers 400 for %s', async (_name, body) => {
    const client = fakeClient();
    const reply = await create({ client, body });

    expect(reply.status).toBe(400);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('trims the label before it stores it', async () => {
    const client = fakeClient();
    await create({ client, body: { ...BODY, label: '  Shift 1  ' } });
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Shift 1' }),
    );
  });

  it('answers 409 when the teacher already has that paper', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'PaperConflict' });
    const reply = await create({
      client: fakeClient({
        create: vi.fn(async () => {
          throw conflict;
        }),
      }),
    });

    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: 'duplicate' });
  });

  it('answers 502 with a fixed message when Supabase fails', async () => {
    const reply = await create({
      client: fakeClient({
        create: vi.fn(async () => {
          throw new Error('policy "papers_insert_own" blocked this');
        }),
      }),
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });

  it('answers 502 when the upload itself fails', async () => {
    const client = fakeClient();
    const store = createMemoryFileStore();
    store.failNext();

    const reply = await create({ client, store });

    expect(reply.status).toBe(502);
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe('handlePaperDownload', () => {
  function download(overrides: Record<string, unknown> = {}) {
    return handlePaperDownload({
      paperId: PAPER_ID,
      kind: 'questions',
      session: session({ role: 'student', teacherStatus: undefined }),
      client: fakeClient({ readOne: vi.fn(async () => storedPaper()) }),
      store: createMemoryFileStore(),
      ...overrides,
    });
  }

  it('sends the student to a signed URL for a live paper', async () => {
    const store = createMemoryFileStore();
    await store.upload({
      path: 'papers/q.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1]),
    });

    const reply = await download({ store });

    expect(reply.status).toBe(302);
    expect(reply.url).toBe('memory://papers/q.pdf?signed=60');
  });

  it('lets the owner download their own draft', async () => {
    const store = createMemoryFileStore();
    await store.upload({
      path: 'papers/q.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1]),
    });

    const reply = await download({
      session: session(),
      client: fakeClient({ readOne: vi.fn(async () => storedPaper({ status: 'draft' })) }),
      store,
    });

    expect(reply.status).toBe(302);
  });

  it('answers 404 for somebody else draft, even if RLS let the row through', async () => {
    const reply = await download({
      client: fakeClient({ readOne: vi.fn(async () => storedPaper({ status: 'draft' })) }),
    });

    expect(reply.status).toBe(404);
    expect(reply.url).toBeUndefined();
  });

  it('answers 404 when there is no paper with that id', async () => {
    const reply = await download({ client: fakeClient({ readOne: vi.fn(async () => null) }) });
    expect(reply.status).toBe(404);
  });

  it('answers 404 when the paper has no PDF of that kind', async () => {
    const reply = await download({ kind: 'solutions' });
    expect(reply.status).toBe(404);
  });

  it('answers 400 for a kind that is not questions or solutions', async () => {
    const reply = await download({ kind: 'everything' });
    expect(reply.status).toBe(400);
  });

  it('answers 401 with no session', async () => {
    const reply = await download({ session: null });
    expect(reply.status).toBe(401);
  });

  it('answers 503 when Supabase is not set up', async () => {
    const reply = await download({ client: fakeClient({ isConfigured: () => false }) });
    expect(reply.status).toBe(503);
  });
});
