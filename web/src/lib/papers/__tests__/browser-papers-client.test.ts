/**
 * Browser-side upload client (issue 10-papers-upload-browse).
 *
 * The 30 MB cap is checked HERE as well as on the server, because a cheap
 * Android phone on 4G must not spend ten minutes uploading a file that the
 * server will refuse in its last byte (DESIGN.md section 10).
 *
 * `fetch` is injected, so no real network call happens in any test
 * (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrowserPapersClient, TEACHER_PAPERS_PATH } from '../browser-papers-client';
import type { PdfPick } from '../types';

const NET = 'a4000001-0000-4000-8000-000000000001';

function pdfFile(size: number, name = 'net-2024.pdf'): PdfPick {
  // A fake, not a real 31 MB buffer: the size check runs before the bytes are
  // ever read, so nothing here is allocated twice.
  return { name, type: 'application/pdf', size } as unknown as PdfPick;
}

function okResponse(body: unknown = { ok: true, paper: { id: 'p1' } }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const DRAFT = { examId: NET, year: 2024, month: 6, label: 'Shift 1' };

describe('createBrowserPapersClient', () => {
  it('posts the fields and the PDF to our own route', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    const paper = await client.create({
      ...DRAFT,
      questions: new File([new Uint8Array([1, 2, 3])], 'q.pdf', { type: 'application/pdf' }),
      solutions: null,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TEACHER_PAPERS_PATH);
    expect(init.method).toBe('POST');

    const form = init.body as FormData;
    expect(form.get('examId')).toBe(NET);
    expect(form.get('year')).toBe('2024');
    expect(form.get('month')).toBe('6');
    expect(form.get('label')).toBe('Shift 1');
    expect(form.get('questions')).toBeInstanceOf(File);
    expect(form.get('solutions')).toBeNull();

    expect(paper).toEqual({ id: 'p1' });
  });

  it('sends an empty month when the teacher left it blank', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await client.create({
      ...DRAFT,
      month: null,
      questions: new File([new Uint8Array([1])], 'q.pdf', { type: 'application/pdf' }),
      solutions: null,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('month')).toBe('');
  });

  it('refuses a 31 MB PDF before it starts the upload', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({ ...DRAFT, questions: pdfFile(31 * 1024 * 1024), solutions: null }),
    ).rejects.toThrow('too-big');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a 31 MB solutions PDF too', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({
        ...DRAFT,
        questions: pdfFile(1000),
        solutions: pdfFile(31 * 1024 * 1024, 'big.pdf'),
      }),
    ).rejects.toThrow('too-big');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a PDF', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({
        ...DRAFT,
        questions: { name: 'scan.jpg', type: 'image/jpeg', size: 10 } as unknown as PdfPick,
        solutions: null,
      }),
    ).rejects.toThrow('not-pdf');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an upload with no PDF picked', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => okResponse());
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({ ...DRAFT, questions: null, solutions: null }),
    ).rejects.toThrow('pdf-required');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a 409 into the duplicate code, so the form can say the right thing', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => new Response('{}', { status: 409 }));
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({
        ...DRAFT,
        questions: new File([new Uint8Array([1])], 'q.pdf', { type: 'application/pdf' }),
        solutions: null,
      }),
    ).rejects.toThrow('duplicate');
  });

  it('turns a 413 into the too-big code', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init: RequestInit = {}) => new Response('{}', { status: 413 }));
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({
        ...DRAFT,
        questions: new File([new Uint8Array([1])], 'q.pdf', { type: 'application/pdf' }),
        solutions: null,
      }),
    ).rejects.toThrow('too-big');
  });

  it('reports any other failure as the status, never a server message', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('policy "papers_insert_own" blocked this', { status: 500 }),
    );
    const client = createBrowserPapersClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.create({
        ...DRAFT,
        questions: new File([new Uint8Array([1])], 'q.pdf', { type: 'application/pdf' }),
        solutions: null,
      }),
    ).rejects.toThrow('Request failed with status 500');
  });
});
