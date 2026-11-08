/**
 * The two route bodies shared by the eight archive route files
 * (issue 45-keep-money-and-scores).
 *
 * Each route file is only `export async function DELETE(...)` handing its
 * path id here, so the cookie read, the client and the reply are written once.
 *
 * DELETE and POST, never GET: these change the world, and a prefetch or a
 * crawler must never be able to archive a product.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { readSessionCookie } from '@/lib/teachers/read-session';
import { handleRemove, handleRestore } from './archive-route';
import { createSupabaseArchiveClient } from './supabase-archive-client';
import type { ArchiveKind } from './types';

export async function removeRoute(
  kind: ArchiveKind,
  id: string,
  request: Request,
): Promise<NextResponse> {
  const session = readSessionCookie(request);
  const reply = await handleRemove({
    kind,
    id,
    session,
    client: createSupabaseArchiveClient({ accessToken: session?.accessToken ?? '' }),
  });
  return NextResponse.json(reply.body, { status: reply.status });
}

export async function restoreRoute(
  kind: ArchiveKind,
  id: string,
  request: Request,
): Promise<NextResponse> {
  const session = readSessionCookie(request);
  const reply = await handleRestore({
    kind,
    id,
    session,
    client: createSupabaseArchiveClient({ accessToken: session?.accessToken ?? '' }),
  });
  return NextResponse.json(reply.body, { status: reply.status });
}
