/**
 * DELETE /api/teacher/mock-tests/<testId> -> { result: 'deleted' | 'archived' }
 * (issue 45-keep-money-and-scores).
 *
 * Thin adapter. A test that was sat, or sits in a set somebody bought, is
 * archived: it takes no new attempt, and old results stay.
 */
import { removeRoute } from '@/lib/archive/route-adapter';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  const { testId } = await params;
  return removeRoute('mock-test', testId, request);
}
