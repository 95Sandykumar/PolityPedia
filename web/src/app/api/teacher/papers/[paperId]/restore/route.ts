/**
 * POST /api/teacher/papers/<paperId>/restore -> an archived paper comes back
 * (issue 45-keep-money-and-scores). Allowed within 30 days.
 */
import { restoreRoute } from '@/lib/archive/route-adapter';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  const { paperId } = await params;
  return restoreRoute('paper', paperId, request);
}
