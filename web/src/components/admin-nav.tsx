'use client';

/**
 * The admin menu, shown on every `/admin/*` page (admin-ui pass).
 *
 * Phone: a sticky strip of tabs that scrolls sideways inside itself, so the
 * page body never scrolls sideways. Laptop (1024 and up): a left sidebar, the
 * same pattern the teacher dashboard uses (DESIGN.md section 7).
 *
 * "Where am I" is `aria-current="page"` plus a filled tab, so it is not colour
 * alone. Links use `prefetch={false}` (web/CLAUDE.md, B3).
 *
 * Source: hand-built from DESIGN.md tokens, Lucide icons (20 px, stroke 2).
 */
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CreditCard,
  KeyRound,
  LayoutDashboard,
  ShieldAlert,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const ITEMS: readonly { href: string; key: MessageKey; Icon: LucideIcon }[] = [
  { href: '/admin', key: 'adminNav.overview', Icon: LayoutDashboard },
  { href: '/admin/teachers', key: 'adminNav.teachers', Icon: Users },
  { href: '/admin/plans', key: 'adminNav.plans', Icon: CreditCard },
  { href: '/admin/payouts', key: 'adminNav.payouts', Icon: Wallet },
  { href: '/admin/alerts', key: 'adminNav.alerts', Icon: ShieldAlert },
  { href: '/admin/set-access', key: 'adminNav.setAccess', Icon: KeyRound },
];

function isHere(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(href + '/');
}

export function AdminNav({ mode = DEFAULT_MODE }: { mode?: LangMode }) {
  const pathname = usePathname() ?? '';
  const hereRef = useRef<HTMLAnchorElement>(null);

  // On a phone the strip scrolls sideways, so bring the current tab into view.
  // `block: 'nearest'` keeps the page itself from jumping.
  useEffect(() => {
    hereRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [pathname]);

  return (
    <nav
      aria-label={plain('adminNav.label', mode)}
      className="border-b border-border py-2 lg:border-0 lg:py-0 lg:pt-4"
    >
      <ul className="flex gap-2 overflow-x-auto px-1 py-1 lg:flex-col lg:overflow-visible lg:p-0">
        {ITEMS.map(({ href, key, Icon }) => {
          const here = isHere(pathname, href);
          return (
            <li key={href} className="shrink-0">
              <Link
                ref={here ? hereRef : undefined}
                href={href}
                prefetch={false}
                aria-current={here ? 'page' : undefined}
                className={
                  'flex min-h-12 items-center gap-2 rounded-[10px] border px-3 text-base font-medium whitespace-nowrap transition-colors duration-100 lg:w-full ' +
                  (here
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:bg-background')
                }
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                {plain(key, mode)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
