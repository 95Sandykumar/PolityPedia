/**
 * Admin > Money alerts (issue 35-reconcile-visible).
 *
 * A6: the nightly reconcile writes a `reconcile_alerts` row for anything that
 * does not line up between Razorpay and our `purchases`. This page is the only
 * thing that reads them. The middleware already keeps non-admins out of
 * `/admin/*` (issue 03), the route checks the session role again, and the
 * `reconcile_alerts_admin_all` policy in 0029 is the real gate.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { AdminAlertsList } from '@/components/admin-alerts-list';
import { readSupabaseEnv } from '@/lib/auth/env';

export default function AdminAlertsPage() {
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <AdminAlertsList configured={readSupabaseEnv() !== null} />
    </main>
  );
}
