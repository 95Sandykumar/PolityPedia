/**
 * Admin > Mock set access (issue 16-set-access-mock-list).
 *
 * Open a teacher's mock set for one student with no payment, for testing and
 * support, or close it again. The middleware already keeps non-admins out of
 * `/admin/*` (issue 03), and Postgres RLS keeps them out of the data.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { AdminSetAccessForm } from '@/components/admin-set-access-form';
import { readSupabaseEnv } from '@/lib/auth/env';

export default function AdminSetAccessPage() {
  return (
    <main className="py-4">
      <AdminSetAccessForm configured={readSupabaseEnv() !== null} />
    </main>
  );
}
