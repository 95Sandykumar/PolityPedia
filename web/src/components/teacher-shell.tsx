'use client';

/**
 * Teacher dashboard shell (issue 07-next-exam-date-teacher-shell, redesigned
 * in teacher-ui).
 *
 * DESIGN.md section 7: "Teacher dashboard: left sidebar on laptop, the same 5
 * slots as a bottom nav on phone: Home, Papers, Mock sets, Batches, Profile."
 * Section 5: max content width 1120 px for the teacher dashboard.
 *
 * ONE `<nav>` with exactly the 5 slots, not two. Rendering a phone nav and a
 * laptop sidebar separately would put every link in the page twice, so a
 * screen reader would read the menu twice and the two copies could drift
 * apart. The switch is CSS only: a fixed bar at the bottom under 768 px, a
 * column on the left from 768 px up. The sidebar wrapper uses `md:order-first`
 * to sit on the left without moving in the DOM, so the page content still
 * comes first for a screen reader on a phone.
 *
 * The three pages that are not in the 5 slots (Notices, Videos, AI
 * explanations) are a second group under the nav on a laptop. They are a
 * plain `role="group"` and not a second `<nav>`, so the page still has one
 * navigation landmark. On a phone they open from Home (quick actions) and each
 * has a "Back to Home" link.
 *
 * Active state: a filled pill behind the icon on a phone, a tinted row with a
 * bar on its left edge on a laptop. Colour is never the only signal: the active
 * label is also bold and the link carries `aria-current="page"`.
 */
import {
  FileText,
  House,
  ListChecks,
  Megaphone,
  Sparkles,
  User,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Lines } from '@/components/teacher-ui';
import { cn } from '@/lib/utils';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';

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

/** Laptop sidebar only: the pages Home opens that are not one of the 5 slots. */
export const TEACHER_MORE: readonly Slot[] = [
  { href: '/teacher/posts', key: 'posts.title', Icon: Megaphone },
  { href: '/teacher/videos', key: 'videos.title', Icon: Video },
  { href: '/teacher/explanations', key: 'teacherEdit.title', Icon: Sparkles },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

const SIDEBAR_LINK =
  'md:flex md:min-h-12 md:flex-row md:items-center md:justify-start md:gap-3 md:rounded-[10px] md:px-3';

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
      <main className="min-w-0 flex-1 px-4 pt-4 pb-24 md:px-6 md:py-6">{children}</main>

      <div className="md:sticky md:top-0 md:order-first md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:gap-4 md:border-r md:border-border md:bg-card md:p-3">
        {/* Laptop only: the product and the role, so the sidebar has a head. */}
        <div className="hidden items-center gap-3 px-2 pt-1 md:flex">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-[10px] bg-primary text-lg font-bold text-primary-foreground"
          >
            P
          </span>
          <span className="flex flex-col">
            <span className="text-base leading-5 font-bold">PolityPedia</span>
            <span className="text-sm leading-5 text-muted-foreground">
              {plain('nav.teacherHome', mode)}
            </span>
          </span>
        </div>

        <nav
          aria-label={plain('nav.label', mode)}
          className={cn(
            'fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]',
            'md:static md:border-t-0 md:pb-0',
          )}
        >
          <ul className="mx-auto flex max-w-[560px] md:max-w-none md:flex-col md:gap-1">
            {TEACHER_SLOTS.map(({ href, key, Icon }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href} className="flex-1 md:flex-none">
                  <Link
                    href={href}
                    prefetch={false}
                    aria-label={plain(key, mode)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-14 flex-col items-center justify-center gap-0.5 py-1 text-sm transition-colors duration-100',
                      SIDEBAR_LINK,
                      active
                        ? 'font-bold text-primary md:bg-primary/10'
                        : 'font-medium text-muted-foreground hover:text-foreground md:hover:bg-background',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-100',
                        'md:h-auto md:w-auto md:bg-transparent',
                        active ? 'bg-primary/10' : '',
                      )}
                    >
                      <Icon size={24} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <span className="flex flex-col items-center text-center leading-5 md:items-start md:text-left">
                      <Lines keyName={key} mode={mode} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div role="group" aria-label={plain('teacherUi.moreNav', mode)} className="hidden md:flex md:flex-col md:gap-1">
          <span className="px-3 pb-1 text-sm font-medium text-muted-foreground">
            {plain('teacherUi.moreNav', mode)}
          </span>
          {TEACHER_MORE.map(({ href, key, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-sm transition-colors duration-100',
                  active
                    ? 'bg-primary/10 font-bold text-primary'
                    : 'font-medium text-muted-foreground hover:bg-background hover:text-foreground',
                )}
              >
                <Icon size={24} strokeWidth={2} aria-hidden="true" />
                <span className="flex flex-col leading-5">
                  <Lines keyName={key} mode={mode} />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
