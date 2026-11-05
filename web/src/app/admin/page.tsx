/**
 * Admin home (issue 03-sign-in, grown by 21-plans-entitlements).
 * Still thin: a title plus the links to the admin tools that exist.
 */
import Link from 'next/link';
import { DEFAULT_MODE, labels, plain } from '@/lib/i18n';

const TOOLS = [
  { href: '/admin/teachers', key: 'adminTeachers.title' },
  { href: '/admin/plans', key: 'plans.title' },
  // Open one mock set for one student (issue 16-set-access-mock-list).
  { href: '/admin/set-access', key: 'setAccess.title' },
  // The monthly bank transfer, X1 (issue 29-ledger-reconcile-payouts).
  { href: '/admin/payouts', key: 'payouts.title' },
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
              className="flex min-h-12 items-center rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground"
            >
              {plain(tool.key, mode)}
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
