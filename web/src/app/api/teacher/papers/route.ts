/**
 * POST /api/teacher/papers -> store one past paper of the caller's own
 * (issue 10-papers-upload-browse).
 *
 * Thin adapter. Every rule lives in `@/lib/papers/papers-route`, which the
 * tests drive directly.
 *
 * The body is `multipart/form-data`, because it carries up to two PDFs. The
 * fields are pulled out one by one and handed over as plain values, so the
 * decision logic never touches a `FormData` and stays easy to test.
 *
 * The Supabase calls carry the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `papers_insert_own` policy inside
 * Postgres and the bucket's own storage policy are the real gate. There is no
 * service-role key in this route, and the row owner never comes from the body.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleCreatePaper } from '@/lib/papers/papers-route';
import { createSupabaseFileStore } from '@/lib/papers/supabase-file-store';
import { createSupabasePapersClient } from '@/lib/papers/supabase-papers-client';
import type { UploadFile } from '@/lib/papers/types';
import { readSessionCookie } from '@/lib/teachers/read-session';

/** One form field as the server-side `UploadFile` the handler expects. */
function readFile(form: FormData, name: string): UploadFile | null {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) return null;
  return {
    name: value.name,
    type: value.type,
    size: value.size,
    // Read LAST, and only after the size check has passed, so a 31 MB file is
    // never pulled into memory.
    bytes: async () => new Uint8Array(await value.arrayBuffer()),
  };
}

/** A form field is always text. '' means "not given". */
function readNumber(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let form: FormData | null = null;
  try {
    form = await request.formData();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const body =
    form === null
      ? null
      : {
          examId: form.get('examId'),
          year: readNumber(form, 'year'),
          month: readNumber(form, 'month'),
          label: form.get('label'),
        };

  const reply = await handleCreatePaper({
    body,
    files: {
      questions: form === null ? null : readFile(form, 'questions'),
      solutions: form === null ? null : readFile(form, 'solutions'),
    },
    session,
    client: createSupabasePapersClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
    store: createSupabaseFileStore({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
