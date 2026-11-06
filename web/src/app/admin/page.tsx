/**
 * Admin home (issue 03-sign-in, grown by 21-plans-entitlements and
 * 35-reconcile-visible, laid out as an overview in the admin-ui pass).
 *
 * One card per admin tool, in two groups: what you check regularly, and the
 * tools that give access. Each card says in one line what it is for.
 *
 * Two cards carry a COUNT, because a link alone is not enough: nobody opens a
 * page that might be empty, and a number is what makes Boss open it.
 *
 *  - Teachers: how many are waiting. Read here on the server with the admin's
 *    own access token, the same read the Teachers page does, so RLS decides.
 *  - Money alerts: how many are open. A client component reads
 *    `/api/admin/alerts`, same as the alerts page itself.
 *
 * Both badges show NOTHING at zero and NOTHING when the read failed: a zero
 * after a failed read would be a lie, so silence means "no news here".
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 *
 * Source: hand-built from DESIGN.md tokens, Lucide icons.
 */
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  ChevronRight,
  Clock,
  CreditCard,
  KeyRound,
  ShieldAlert,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { AdminOpenAlertsCount } from '@/components/admin-open-alerts-count';
import { CARD, Chip } from '@/components/admin-ui';
import { readSupabaseEnv } from '@/lib/auth/env';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';

interface Tool {
  href: string;
  title: MessageKey;
  purpose: MessageKey;
  Icon: LucideIcon;
}

const REVIEW: readonly Tool[] = [
  {
    href: '/admin/teachers',
    title: 'adminNav.teachers',
    purpose: 'adminHome.teachersPurpose',
    Icon: Users,
  },
  // What the nightly reconcile found, A6 (issue 35-reconcile-visible).
  {
    href: '/admin/alerts',
    title: 'adminNav.alerts',
    purpose: 'adminHome.alertsPurpose',
    Icon: ShieldAlert,
  },
  // The monthly bank transfer, X1 (issue 29-ledger-reconcile-payouts).
  {
    href: '/admin/payouts',
    title: 'adminNav.payouts',
    purpose: 'adminHome.payoutsPurpose',
    Icon: Wallet,
  },
];

const ACCESS: readonly Tool[] = [
  {
    href: '/admin/plans',
    title: 'adminNav.plans',
    purpose: 'adminHome.plansPurpose',
    Icon: CreditCard,
  },
  // Open one mock set for one student (issue 16-set-access-mock-list).
  {
    href: '/admin/set-access',
    title: 'adminNav.setAccess',
    purpose: 'adminHome.setAccessPurpose',
    Icon: KeyRound,
  },
];

/** Teachers waiting, or null when unknown. Never a wrong zero. */
async function pendingTeachers(): Promise<number | null> {
  if (readSupabaseEnv() === null) return null;
  try {
    const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
    const rows = await createSupabaseTeachersClient({
      accessToken: session?.accessToken ?? '',
    }).listPending();
    return rows.length;
  } catch {
    return null;
  }
}

function ToolCard({
  tool,
  mode,
  badge,
}: {
  tool: Tool;
  mode: LangMode;
  badge?: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={tool.href}
        prefetch={false}
        className={
          CARD +
          ' group flex h-full min-h-[120px] flex-col gap-3 p-4 transition-colors duration-100 hover:border-primary'
        }
      >
        <span className="flex items-start justify-between gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <tool.Icon className="size-5" />
          </span>
          {badge}
        </span>
        <span className="flex flex-1 flex-col gap-1">
          <span className="flex items-center justify-between gap-2 text-lg leading-6 font-bold">
            {plain(tool.title, mode)}
            <ChevronRight aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <span className="text-sm text-muted-foreground">{plain(tool.purpose, mode)}</span>
        </span>
      </Link>
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg leading-6 font-bold">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
    </section>
  );
}

export default async function AdminPage() {
  const mode = DEFAULT_MODE;
  const waiting = await pendingTeachers();

  return (
    <main className="flex flex-col gap-6 py-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold">
          {plain('nav.adminHome', mode)}
        </h1>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          {plain('adminHome.hint', mode)}
        </p>
      </header>

      <Group title={plain('adminHome.sectionReview', mode)}>
        {REVIEW.map((tool) => (
          <ToolCard
            key={tool.href}
            tool={tool}
            mode={mode}
            badge={
              tool.href === '/admin/alerts' ? (
                <AdminOpenAlertsCount mode={mode} />
              ) : tool.href === '/admin/teachers' && waiting !== null && waiting > 0 ? (
                <Chip tone="warn" icon={<Clock aria-hidden="true" className="size-3.5" />}>
                  <span className="font-bold tabular-nums">{waiting}</span>
                  <span>{plain('adminHome.waiting', mode)}</span>
                </Chip>
              ) : undefined
            }
          />
        ))}
      </Group>

      <Group title={plain('adminHome.sectionAccess', mode)}>
        {ACCESS.map((tool) => (
          <ToolCard key={tool.href} tool={tool} mode={mode} />
        ))}
      </Group>
    </main>
  );
}
