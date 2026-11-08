/**
 * DELETE /api/teacher/papers/<paperId> -> { result: 'deleted' | 'archived' }
 * (issue 45-keep-money-and-scores).
 *
 * Thin adapter. A paper somebody has sat is archived, so the student keeps
 * their result; an unsat paper is deleted.
 */
import { removeRoute } from '@/lib/archive/route-adapter';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  const { paperId } = await params;
  return removeRoute('paper', paperId, request);
}
