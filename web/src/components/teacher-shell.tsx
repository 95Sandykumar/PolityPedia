'use client';

/**
 * Teacher dashboard shell (issue 07-next-exam-date-teacher-shell).
 *
 * DESIGN.md section 7: "Teacher dashboard: left sidebar on laptop, the same 5
 * slots as a bottom nav on phone: Home, Papers, Mock sets, Batches, Profile."
 * Section 5: max content width 1120 px for the teacher dashboard.
 *
 * ONE `<nav>`, not two. Rendering a phone nav and a laptop sidebar separately
 * would put every link in the page twice, so a screen reader would read the
 * menu twice and the two copies could drift apart. The switch is CSS only: a
 * fixed bar at the bottom under 768 px, a column on the left from 768 px up.
 * `md:order-first` moves it to the left without moving it in the DOM, so the
 * page content still comes first for a screen reader on a phone.
 */
import { FileText, House, ListChecks, User, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

interface Slot {
  href: string;
  key: MessageKey;
  Icon: LucideIcon;
}

/** The 5 slots of DESIGN.md section 7, in the order it lists them. */
export const TEACHER_SLOTS: readonly Slot[] = [
  { href: '/teacher/home', key: 'nav.home', Icon: House },
  { href: '/teacher/papers', key: 'nav.papers', Icon: FileText },
  { href: '/teacher/mocks', key: 'nav.mockSets', Icon: ListChecks },
  { href: '/teacher/batches', key: 'nav.batches', Icon: Users },
  { href: '/teacher/profile', key: 'nav.profile', Icon: User },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TeacherShell({
  children,
  mode = DEFAULT_MODE,
}: {
  children: ReactNode;
  mode?: LangMode;
}) {
  const pathname = usePathname() ?? '/teacher/home';
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1120px] flex-col md:flex-row">
      <main className="flex-1 px-4 pt-4 pb-24 md:pb-4">{children}</main>

      <nav
        aria-label={plain('nav.label', mode)}
        className={cn(
          'fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]',
          'md:static md:order-first md:w-56 md:shrink-0 md:border-t-0 md:border-r md:pb-0',
        )}
      >
        <ul className="mx-auto flex max-w-[560px] md:max-w-none md:flex-col md:gap-1 md:p-2">
          {TEACHER_SLOTS.map(({ href, key, Icon }) => {
            const active = isActive(pathname, href);
            const [first, second] = labels(key, mode);
            return (
              <li key={href} className="flex-1 md:flex-none">
                <Link
                  href={href}
                  prefetch={false}
                  aria-label={plain(key, mode)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 flex-col items-center justify-center gap-0.5 py-1 text-sm font-medium transition-colors duration-100',
                    'md:flex-row md:justify-start md:gap-2 md:rounded-[10px] md:px-3',
                    active ? 'text-primary md:bg-background' : 'text-muted-foreground',
                  )}
                >
                  <Icon size={24} strokeWidth={2} aria-hidden="true" />
                  <span className="md:flex md:flex-col md:items-start">
                    <span>{first}</span>
                    {second ? <span className="block text-xs">{second}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
