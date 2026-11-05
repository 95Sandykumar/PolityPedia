'use client';

import { BookOpenCheck, Bookmark, House, User, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

interface Tab {
  href: string;
  key: MessageKey;
  Icon: LucideIcon;
}

export const TABS: readonly Tab[] = [
  { href: '/', key: 'nav.home', Icon: House },
  { href: '/teachers', key: 'nav.teachers', Icon: Users },
  { href: '/practice', key: 'nav.practice', Icon: BookOpenCheck },
  { href: '/saved', key: 'nav.saved', Icon: Bookmark },
  { href: '/me', key: 'nav.me', Icon: User },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function StudentShell({
  children,
  mode = DEFAULT_MODE,
}: {
  children: ReactNode;
  mode?: LangMode;
}) {
  const pathname = usePathname() ?? '/';
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col">
      <main className="flex-1 px-4 pt-4 pb-24">{children}</main>
      <nav
        aria-label={plain('nav.label', mode)}
        className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto flex max-w-[560px]">
          {TABS.map(({ href, key, Icon }) => {
            const active = isActive(pathname, href);
            const [first, second] = labels(key, mode);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  prefetch={false}
                  aria-label={plain(key, mode)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 flex-col items-center justify-center gap-0.5 py-1 text-sm font-medium transition-colors duration-100',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <Icon size={24} strokeWidth={2} aria-hidden="true" />
                  <span>{first}</span>
                  {second ? <span className="text-xs">{second}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
