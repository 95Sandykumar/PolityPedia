/**
 * POST /api/teacher/mock-tests/<testId>/restore -> an archived test comes back
 * (issue 45-keep-money-and-scores). Allowed within 30 days.
 */
import { restoreRoute } from '@/lib/archive/route-adapter';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
) {
  const { testId } = await params;
  return restoreRoute('mock-test', testId, request);
}
