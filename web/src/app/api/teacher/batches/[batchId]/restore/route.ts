/**
 * POST /api/teacher/batches/<batchId>/restore -> an archived batch comes back
 * (issue 45-keep-money-and-scores). Allowed within 30 days; the batch's free
 * sets return to its members.
 */
import { restoreRoute } from '@/lib/archive/route-adapter';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  return restoreRoute('batch', batchId, request);
}
