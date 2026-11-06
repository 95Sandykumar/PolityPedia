/**
 * Small shared pieces of the teacher dashboard (teacher-ui).
 *
 * DESIGN.md is the law here: Clean Swiss, 1 px borders, no shadow, no
 * gradient, radius 10, 12 px gaps, tokens only. What changes from the old
 * screens is STRUCTURE, not paint: every screen now opens with the same header
 * (title, one line of help, one primary action), lists are rows with a status
 * chip, and a form lives in its own titled card. A teacher learns the pattern
 * once and every page reads the same.
 *
 * Presentational only: no state, no fetch, no 'use client', so a server page
 * and a client component can both use it.
 *
 * Hindi: Devanagari needs more line height, so a Hindi line gets +2 px
 * (DESIGN.md section 4) and the Hindi line under an English one in `both` mode
 * is a little taller than the 16 px a Latin 12 px line gets.
 */
import { ArrowLeft, Check, CircleDot, Pencil, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { labels, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** 48 px tall, the touch-target floor (DESIGN.md section 5). */
export const PRIMARY_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-base font-medium text-primary-foreground transition-colors duration-100 hover:bg-primary/90 disabled:opacity-60';

export const QUIET_BUTTON =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 hover:bg-background disabled:opacity-60';

export const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground placeholder:text-muted-foreground';

export const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** The line-height bump for Devanagari. */
export function hindiLine(mode: LangMode, index: number): boolean {
  return mode === 'hi' || (mode === 'both' && index === 1);
}

/**
 * The lines of one label: one `<span>` each, English first, Hindi under it in
 * `both` mode. `sub` is the class of the second line.
 */
export function Lines({
  keyName,
  mode,
  sub = 'text-xs',
}: {
  keyName: MessageKey;
  mode: LangMode;
  sub?: string;
}) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span
          key={line}
          className={cn(
            'block',
            index === 1 && sub,
            hindiLine(mode, index) && (index === 1 ? 'leading-[18px]' : 'leading-[26px]'),
          )}
        >
          {line}
        </span>
      ))}
    </>
  );
}

/** A visible label above the box. The control inside keeps its own aria-label. */
export function Field({
  labelKey,
  mode,
  children,
}: {
  labelKey: MessageKey;
  mode: LangMode;
  children: ReactNode;
}) {
  return (
    <label className="flex w-full flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">
        <Lines keyName={labelKey} mode={mode} />
      </span>
      {children}
    </label>
  );
}

/**
 * The top of every teacher screen: where you are, one line of help, and the
 * one thing you most likely came to do (`action`).
 */
export function PageHeader({
  titleKey,
  title,
  mode,
  subtitle,
  action,
  back,
  icon: Icon,
}: {
  titleKey?: MessageKey;
  /** A literal title, for a screen named by data (a batch name, a set name). */
  title?: string;
  mode: LangMode;
  subtitle?: string;
  action?: ReactNode;
  back?: { href: string; label: string };
  icon?: LucideIcon;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {back ? (
          <Link
            href={back.href}
            prefetch={false}
            className="-ml-1 inline-flex min-h-11 w-fit items-center gap-1 rounded-[10px] px-1 text-sm font-medium text-muted-foreground hover:text-primary"
          >
            <ArrowLeft size={20} strokeWidth={2} aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}

        <div className="flex items-center gap-3">
          {Icon ? (
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
            >
              <Icon size={24} strokeWidth={2} />
            </span>
          ) : null}
          <h1
            className={cn(
              'min-w-0 text-[22px] font-bold break-words',
              mode === 'en' ? 'leading-7' : 'leading-[30px]',
            )}
          >
            {title !== undefined ? (
              title
            ) : titleKey ? (
              <Lines keyName={titleKey} mode={mode} sub="text-sm font-medium text-muted-foreground" />
            ) : null}
          </h1>
        </div>

        {subtitle ? (
          <p className="text-sm text-muted-foreground sm:max-w-prose">{subtitle}</p>
        ) : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** Live or Draft. An icon AND a word, so colour never works alone. */
export function StatusChip({
  live,
  children,
  className,
}: {
  live: boolean;
  children: ReactNode;
  className?: string;
}) {
  const Icon = live ? CircleDot : Pencil;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        live ? 'bg-primary/10 text-primary' : 'border border-border bg-card text-muted-foreground',
        className,
      )}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A small neutral fact (a count, a PDF kind) on a row. */
export function MetaChip({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-muted-foreground">
      {Icon ? <Icon size={12} strokeWidth={2} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * Empty state (DESIGN.md section 9): one icon, one line, one action. The line
 * is the live region; the action sits outside it so a screen reader does not
 * read the button as part of the message.
 */
export function EmptyState({
  icon: Icon,
  text,
  action,
}: {
  icon: LucideIcon;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-border bg-card px-4 py-8 text-center">
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
      >
        <Icon size={24} strokeWidth={2} />
      </span>
      <p role="status" className="max-w-[32ch] text-muted-foreground">
        {text}
      </p>
      {action}
    </div>
  );
}

/**
 * A titled card for a form. `id` is the anchor the header action scrolls to,
 * so the teacher lands on the form and not just somewhere near it.
 */
export function FormPanel({
  id,
  titleKey,
  mode,
  icon: Icon,
  children,
  className,
}: {
  id: string;
  titleKey: MessageKey;
  mode: LangMode;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(CARD, 'flex scroll-mt-4 flex-col gap-3', className)}
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-[18px] leading-6 font-bold">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
        >
          <Icon size={20} strokeWidth={2} />
        </span>
        <span>
          <Lines keyName={titleKey} mode={mode} sub="text-sm font-medium text-muted-foreground" />
        </span>
      </h2>
      {children}
    </section>
  );
}

/** A section heading for a list under the header (h2). */
export function SectionTitle({
  keyName,
  mode,
  count,
}: {
  keyName: MessageKey;
  mode: LangMode;
  count?: number;
}) {
  return (
    <h2 className="flex items-baseline gap-2 text-[18px] leading-6 font-bold">
      <span>
        <Lines keyName={keyName} mode={mode} sub="text-sm font-medium text-muted-foreground" />
      </span>
      {count !== undefined ? (
        <span className="text-sm font-medium text-muted-foreground tabular-nums">{count}</span>
      ) : null}
    </h2>
  );
}

/**
 * The two-column body of a list screen: the list on the left, the form card
 * on the right and sticky on a laptop. One column on a phone, list first.
 */
export function ListLayout({ list, form }: { list: ReactNode; form: ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">{list}</div>
      <div className="lg:sticky lg:top-4">{form}</div>
    </div>
  );
}

/** Scroll to a form and put the cursor in its first field. */
export function goToForm(id: string) {
  const panel = typeof document === 'undefined' ? null : document.getElementById(id);
  if (!panel) return;
  const reduce =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  panel.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  panel.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
}

export type StepState = 'done' | 'now' | 'next';

/**
 * Numbered steps with a state each. State is never colour alone: a done step
 * shows a tick, the current one has a heavy ring and bold text and carries
 * `aria-current="step"`, and a step still to come is muted. The list is an
 * `<ol>`, so a screen reader announces the order itself.
 */
export function Steps({
  steps,
  mode,
}: {
  steps: readonly { key: MessageKey; state: StepState }[];
  mode: LangMode;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={step.state === 'now' ? 'step' : undefined}
          className="flex items-center gap-3"
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums',
              step.state === 'done' && 'bg-primary text-primary-foreground',
              step.state === 'now' && 'border-2 border-primary text-primary',
              step.state === 'next' && 'border border-border text-muted-foreground',
            )}
          >
            {step.state === 'done' ? <Check size={16} strokeWidth={3} /> : index + 1}
          </span>
          <span
            className={cn(
              'leading-5',  
              step.state === 'next' ? 'text-muted-foreground' : 'font-medium text-foreground',
            )}
          >
            <Lines keyName={step.key} mode={mode} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The product mark and name, for the screens that have no sidebar. */
export function BrandMark({ mode }: { mode: LangMode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-[10px] bg-primary text-lg font-bold text-primary-foreground"
      >
        P
      </span>
      <span className="flex flex-col">
        <span className="text-base leading-5 font-bold">PolityPedia</span>
        <span className="text-sm leading-5 text-muted-foreground">
          {labels('nav.teacherHome', mode).join(' / ')}
        </span>
      </span>
    </div>
  );
}
