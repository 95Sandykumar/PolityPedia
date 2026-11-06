/**
 * Admin > Plans (issue 21-plans-entitlements).
 *
 * Give a student the AI plan (Rs 100) or Pro (Rs 500) for testing, or end it.
 * The middleware already keeps non-admins out of `/admin/*` (issue 03), and
 * Postgres RLS keeps them out of the data.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { AdminPlansForm } from '@/components/admin-plans-form';
import { readSupabaseEnv } from '@/lib/auth/env';

export default function AdminPlansPage() {
  return (
    <main className="py-4">
      <AdminPlansForm configured={readSupabaseEnv() !== null} />
    </main>
  );
}
