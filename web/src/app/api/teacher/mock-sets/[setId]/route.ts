/**
 * DELETE /api/teacher/mock-sets/<setId> -> { result: 'deleted' | 'archived' }
 * (issue 45-keep-money-and-scores).
 *
 * Thin adapter. Postgres decides: a set nobody bought, sat or was given is
 * deleted; any other set is archived, so payments, buyers' access and scores
 * stay. See `@/lib/archive/archive-route`.
 */
import { removeRoute } from '@/lib/archive/route-adapter';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ setId: string }> },
) {
  const { setId } = await params;
  return removeRoute('mock-set', setId, request);
}
