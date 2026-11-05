/**
 * Admin home (issue 03-sign-in, grown by 21-plans-entitlements and
 * 35-reconcile-visible).
 * Still thin: a title plus the links to the admin tools that exist.
 *
 * Money alerts carry a COUNT beside the link (issue 35-reconcile-visible).
 * The nightly reconcile runs at 2 AM and nobody opens a page that might be
 * empty, so the number is what makes Boss open it. The badge is a client
 * component, which keeps this page a plain server render with no data fetch
 * and no token: it reads `/api/admin/alerts`, same as the page itself.
 */
import Link from 'next/link';
import { AdminOpenAlertsCount } from '@/components/admin-open-alerts-count';
import { DEFAULT_MODE, labels, plain } from '@/lib/i18n';

const TOOLS = [
  { href: '/admin/teachers', key: 'adminTeachers.title' },
  { href: '/admin/plans', key: 'plans.title' },
  // Open one mock set for one student (issue 16-set-access-mock-list).
  { href: '/admin/set-access', key: 'setAccess.title' },
  // The monthly bank transfer, X1 (issue 29-ledger-reconcile-payouts).
  { href: '/admin/payouts', key: 'payouts.title' },
  // What the nightly reconcile found, A6 (issue 35-reconcile-visible).
  { href: '/admin/alerts', key: 'alerts.title' },
] as const;

export default function AdminPage() {
  const mode = DEFAULT_MODE;
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <section className="flex flex-col gap-3">
        <h1 className="text-[22px] leading-7 font-bold">
          {labels('nav.adminHome', mode).map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>
        <nav className="flex flex-col gap-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              prefetch={false}
              className="flex min-h-12 items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground"
            >
              <span>{plain(tool.key, mode)}</span>
              {tool.href === '/admin/alerts' ? <AdminOpenAlertsCount mode={mode} /> : null}
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
