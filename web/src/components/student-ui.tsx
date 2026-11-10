/**
 * Small shared pieces for the student screens (student-ui pass, 2026-11-06).
 *
 * Why this file exists: every student page used to hand-roll the same title,
 * the same section heading and the same "nothing here" line, so the screens
 * read as bare lists. These four pieces give every screen the same rhythm:
 * a page header, section headings with an icon chip and a count, and one warm
 * empty state with one action. They carry no data and no state, so they are
 * server-safe and add nothing to the client bundle.
 *
 * Rules kept from DESIGN.md: tokens only (the soft tints are the primary token
 * at low opacity, not a new colour), 1 px borders, radius 10, no shadows, no
 * gradients, 48 px touch targets, Hindi lines never clipped (leading is set on
 * every block that can hold Devanagari).
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronLeft, type LucideIcon } from 'lucide-react';
import { labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The label as one block per language (English first, Hindi small under it). */
export function Lines({
  keyName,
  mode,
  className,
}: {
  keyName: MessageKey;
  mode: LangMode;
  className?: string;
}) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={cn('block', index === 0 ? undefined : 'text-xs', className)}>
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * The page title (the one `h1`), with an optional line under it and an
 * optional slot on the right (a count, a pill).
 */
export function PageHeader({
  titleKey,
  mode,
  hintKey,
  aside,
  title,
}: {
  titleKey?: MessageKey;
  mode: LangMode;
  hintKey?: MessageKey;
  aside?: ReactNode;
  /** A plain string title, for pages titled by a teacher's name. */
  title?: string;
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-8 font-bold">
          {title ? title : titleKey ? <Lines keyName={titleKey} mode={mode} /> : null}
        </h1>
        {hintKey ? (
          <p className="pt-1 text-sm leading-5 text-muted-foreground">{plain(hintKey, mode)}</p>
        ) : null}
      </div>
      {aside}
    </header>
  );
}

/** The soft square an icon sits in. Primary at 10 percent: a tint, not a new colour. */
export function IconChip({
  Icon,
  className,
  size = 'md',
}: {
  Icon: LucideIcon;
  className?: string;
  size?: 'md' | 'lg';
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary',
        size === 'lg' ? 'size-12' : 'size-9',
        className,
      )}
    >
      <Icon className={size === 'lg' ? 'size-6' : 'size-5'} strokeWidth={2} />
    </span>
  );
}

/**
 * A section heading (`h2`): icon chip, title, optional count pill, optional
 * link on the right. Pass `children` for a title that is not a label key.
 */
export function SectionTitle({
  Icon,
  titleKey,
  mode,
  count,
  action,
  children,
}: {
  Icon?: LucideIcon;
  titleKey?: MessageKey;
  mode: LangMode;
  count?: number;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {Icon ? <IconChip Icon={Icon} /> : null}
      <h2 className="min-w-0 text-[18px] leading-7 font-bold">
        {children ?? (titleKey ? <Lines keyName={titleKey} mode={mode} /> : null)}
      </h2>
      {typeof count === 'number' ? (
        <span className="rounded-full bg-primary/10 px-2 text-sm leading-6 font-medium text-primary tabular-nums">
          {count}
        </span>
      ) : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

/** The small link on the right of a section heading. 48 px tall tap area. */
export function SectionLink({
  href,
  children,
  ariaLabel,
  testId,
}: {
  href: string;
  children: ReactNode;
  ariaLabel?: string;
  /** So a caller's own test can find its link. Undefined renders no attribute. */
  testId?: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={ariaLabel}
      data-testid={testId}
      className="inline-flex min-h-12 items-center text-sm font-medium text-primary"
    >
      {children}
    </Link>
  );
}

/**
 * The one empty state (DESIGN.md section 9): one icon, one line, and at most
 * one action. It is the `role="status"` element of its screen, so a screen
 * reader hears it, and it holds the same words the old bare line did.
 */
export function EmptyState({
  Icon,
  text,
  hint,
  action,
  tone = 'default',
}: {
  Icon: LucideIcon;
  text: string;
  hint?: string;
  action?: { href: string; label: string };
  tone?: 'default' | 'plain';
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border px-4 py-8 text-center',
        tone === 'default' ? 'bg-card' : 'bg-transparent',
      )}
    >
      <IconChip Icon={Icon} size="lg" className="rounded-full" />
      <p className="text-base leading-6 font-medium">{text}</p>
      {hint ? <p className="max-w-[34ch] text-sm leading-5 text-muted-foreground">{hint}</p> : null}
      {action ? (
        <Link
          href={action.href}
          prefetch={false}
          className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-primary px-5 text-base font-medium text-primary-foreground transition-colors duration-100"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** "Back to teacher" above a tile page, so the way up is one tap (DESIGN.md section 7). */
export function BackLink({
  href,
  mode,
  labelKey = 'sui.backToTeacher',
}: {
  href: string;
  mode: LangMode;
  labelKey?: MessageKey;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="-ml-1 inline-flex min-h-12 w-fit items-center gap-1 text-sm font-medium text-primary"
    >
      <ChevronLeft aria-hidden="true" className="size-5" strokeWidth={2} />
      {plain(labelKey, mode)}
    </Link>
  );
}

/** A card shell. Thin border, no shadow (DESIGN.md section 0). */
export const CARD = 'rounded-[10px] border border-border bg-card';
