/**
 * Server-side papers client and file store (issue 10-papers-upload-browse).
 *
 * `fetch` and the env bag are injected, so there is no real network call and
 * no real key in this test (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { PAPERS_BUCKET } from '../types';
import { createSupabaseFileStore } from '../supabase-file-store';
import { createSupabasePapersClient } from '../supabase-papers-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const TEACHER = '44444444-4444-4444-8444-444444444444';
const NET = 'a4000001-0000-4000-8000-000000000001';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    teacher_id: TEACHER,
    exam_id: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    pdf_questions_path: 'papers/q.pdf',
    pdf_solutions_path: null,
    status: 'live',
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch, env = ENV) {
  return createSupabasePapersClient({
    accessToken: 'caller-token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

describe('createSupabasePapersClient', () => {
  it('reports not configured with no env, and never fires a request', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([]));
    const papers = client(fetchImpl as unknown as typeof fetch, {} as typeof ENV);

    expect(papers.isConfigured()).toBe(false);
    expect(await papers.listMine()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the caller own papers with the caller own token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row({ status: 'draft' })]));
    const papers = client(fetchImpl as unknown as typeof fetch);

    const mine = await papers.listMine();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rest/v1/papers');
    expect(url).toContain(`teacher_id=eq.${TEACHER}`);
    expect(url).not.toContain('select=*');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer caller-token');

    expect(mine).toEqual([
      {
        id: '99999999-9999-4999-8999-999999999999',
        teacherId: TEACHER,
        examId: NET,
        year: 2024,
        month: 6,
        label: 'Shift 1',
        questionsPath: 'papers/q.pdf',
        solutionsPath: null,
        status: 'draft',
      },
    ]);
  });

  it('asks only for live papers when a student browses a teacher', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row()]));
    const papers = client(fetchImpl as unknown as typeof fetch);

    await papers.listLiveForTeacher(TEACHER);

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain('status=eq.live');
    expect(url).toContain(`teacher_id=eq.${TEACHER}`);
  });

  it('gives an empty list when Supabase answers with an error', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json({ message: 'boom' }, 500));
    const papers = client(fetchImpl as unknown as typeof fetch);

    expect(await papers.listMine()).toEqual([]);
  });

  it('drops a row with an unknown status instead of trusting it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row({ status: 'whatever' }), row()]));
    const papers = client(fetchImpl as unknown as typeof fetch);

    expect(await papers.listMine()).toHaveLength(1);
  });

  it('sets the owner from the session when it creates a paper, and starts it as a draft', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row({ status: 'draft' })], 201));
    const papers = client(fetchImpl as unknown as typeof fetch);

    const made = await papers.create({
      examId: NET,
      year: 2024,
      month: 6,
      label: 'Shift 1',
      questionsPath: 'papers/q.pdf',
      solutionsPath: null,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      teacher_id: TEACHER,
      exam_id: NET,
      year: 2024,
      month: 6,
      label: 'Shift 1',
      pdf_questions_path: 'papers/q.pdf',
      pdf_solutions_path: null,
      status: 'draft',
    });
    expect(made.status).toBe('draft');
  });

  it('marks a duplicate so the route can answer 409, and never echoes the body', async () => {
    const fetchImpl = vi.fn(
      async () => json({ message: 'duplicate key value violates papers_unique' }, 409),
    );
    const papers = client(fetchImpl as unknown as typeof fetch);

    await expect(
      papers.create({
        examId: NET,
        year: 2024,
        month: null,
        label: 'Shift 1',
        questionsPath: 'papers/q.pdf',
        solutionsPath: null,
      }),
    ).rejects.toMatchObject({ name: 'PaperConflict' });
  });

  it('reads one paper by id', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row()]));
    const papers = client(fetchImpl as unknown as typeof fetch);

    const found = await papers.readOne('99999999-9999-4999-8999-999999999999');

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain('id=eq.99999999-9999-4999-8999-999999999999');
    expect(found?.label).toBe('Shift 1');
  });

  it('gives null for a paper id that is not a uuid, with no request at all', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json([row()]));
    const papers = client(fetchImpl as unknown as typeof fetch);

    expect(await papers.readOne('../../secret')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createSupabaseFileStore', () => {
  function store(fetchImpl: typeof fetch) {
    return createSupabaseFileStore({ accessToken: 'caller-token', env: ENV, fetchImpl });
  }

  it('puts the PDF in the papers bucket with the caller own token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json({ Key: 'papers/x.pdf' }));
    await store(fetchImpl as unknown as typeof fetch).upload({
      path: 'papers/x.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://project.supabase.co/storage/v1/object/${PAPERS_BUCKET}/papers/x.pdf`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer caller-token');
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['x-upsert']).toBe('false');
  });

  it('throws the status only when an upload fails', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => new Response('bucket policy says no', { status: 403 }));

    await expect(
      store(fetchImpl as unknown as typeof fetch).upload({
        path: 'papers/x.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('Supabase paper upload failed with status 403');
  });

  it('turns a signed path into an absolute URL', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) =>
      json({ signedURL: '/object/sign/papers/papers/x.pdf?token=abc' }),
    );

    const url = await store(fetchImpl as unknown as typeof fetch).signedUrl('papers/x.pdf', 120);

    const [called, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(called).toBe(
      `https://project.supabase.co/storage/v1/object/sign/${PAPERS_BUCKET}/papers/x.pdf`,
    );
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 120 });
    expect(url).toBe(
      'https://project.supabase.co/storage/v1/object/sign/papers/papers/x.pdf?token=abc',
    );
  });

  it('gives null when the file is gone, so the route can answer 404', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => json({ message: 'not found' }, 404));
    expect(await store(fetchImpl as unknown as typeof fetch).signedUrl('papers/x.pdf')).toBeNull();
  });
});
