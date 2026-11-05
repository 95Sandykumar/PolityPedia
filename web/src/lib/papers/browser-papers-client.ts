/**
 * Browser-side papers client (issue 10-papers-upload-browse).
 *
 * The page never holds a Supabase key and never sees a token. It posts the
 * PDFs to our own route handler; that reads the teacher's access token out of
 * the httpOnly session cookie and lets Postgres RLS and the storage policy
 * decide.
 *
 * The 30 MB cap is checked HERE too, before the first byte leaves: a cheap
 * Android phone on 4G must not spend ten minutes uploading a file the server
 * will refuse in its last byte (DESIGN.md section 10). The server checks it
 * again, because a browser check is a courtesy, never a rule.
 *
 * Security: the thrown message is a short CODE of ours or the HTTP status, so
 * a Postgres policy name or a storage error is never echoed into the page.
 */
import {
  checkPdf,
  type BrowserPapersClient,
  type NewPaperInput,
  type Paper,
  type PdfPick,
} from './types';

export const TEACHER_PAPERS_PATH = '/api/teacher/papers';

/** Codes the form turns into one short line. Never a server message. */
export type UploadErrorCode =
  | 'pdf-required'
  | 'too-big'
  | 'not-pdf'
  | 'duplicate'
  | 'empty';

function refuse(code: UploadErrorCode): never {
  throw new Error(code);
}

export function createBrowserPapersClient(fetchImpl?: typeof fetch): BrowserPapersClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async create(input: NewPaperInput): Promise<Paper> {
      const picked: [string, PdfPick][] = [];
      if (input.questions) picked.push(['questions', input.questions]);
      if (input.solutions) picked.push(['solutions', input.solutions]);
      if (picked.length === 0) refuse('pdf-required');

      // Every file is checked before anything is sent, so a good questions PDF
      // is never uploaded next to a refused solutions PDF.
      for (const [, file] of picked) {
        const problem = checkPdf(file);
        if (problem !== null) refuse(problem);
      }

      const form = new FormData();
      form.set('examId', input.examId);
      form.set('year', String(input.year));
      // Empty string, not "null": a form field is always text, and the route
      // reads an empty month as "year only".
      form.set('month', input.month === null ? '' : String(input.month));
      form.set('label', input.label);
      for (const [name, file] of picked) form.set(name, file, file.name);

      // No content-type header on purpose: the browser adds the multipart
      // boundary itself, and setting it by hand breaks the parse on the server.
      const res = await doFetch(TEACHER_PAPERS_PATH, { method: 'POST', body: form });

      if (res.status === 409) refuse('duplicate');
      if (res.status === 413) refuse('too-big');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { paper?: Paper };
      if (!body?.paper) throw new Error('Request failed with status ' + res.status);
      return body.paper;
    },
  };
}
