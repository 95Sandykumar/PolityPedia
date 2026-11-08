/**
 * POST /api/teacher/mock-sets/<setId>/restore -> an archived set comes back
 * (issue 45-keep-money-and-scores). Allowed within 30 days.
 */
import { restoreRoute } from '@/lib/archive/route-adapter';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ setId: string }> },
) {
  const { setId } = await params;
  return restoreRoute('mock-set', setId, request);
}
