/**
 * DELETE /api/teacher/batches/<batchId> -> { result: 'deleted' | 'archived' }
 * (issue 45-keep-money-and-scores).
 *
 * Thin adapter. A batch with members is archived: its free sets are withdrawn
 * from the members and its reports stay readable. An empty batch is deleted.
 */
import { removeRoute } from '@/lib/archive/route-adapter';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  return removeRoute('batch', batchId, request);
}
