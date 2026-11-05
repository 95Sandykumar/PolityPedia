/**
 * Admin > Teacher payouts (issue 29-ledger-reconcile-payouts).
 *
 * X1: the monthly manual bank transfer. The screen shows what each teacher is
 * still owed per month, and Mark paid records the transfer Boss has already
 * made in the bank. The middleware already keeps non-admins out of `/admin/*`
 * (issue 03), and the `is_admin()` guard inside `payout_report()` and
 * `mark_payout_paid()` keeps them out of the data.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { AdminPayoutsForm } from '@/components/admin-payouts-form';
import { readSupabaseEnv } from '@/lib/auth/env';

export default function AdminPayoutsPage() {
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <AdminPayoutsForm configured={readSupabaseEnv() !== null} />
    </main>
  );
}
