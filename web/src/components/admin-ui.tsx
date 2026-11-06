/**
 * Small shared building blocks for the admin screens (admin-ui pass).
 *
 * DESIGN.md: Clean Swiss. 1 px borders, no shadows, no gradients, radius 10,
 * 12 px gaps, 48 px touch targets, tokens only. Colour never works alone: every
 * tone below carries an icon or a word as well.
 *
 * Source: hand-built from DESIGN.md tokens (Lucide icons, shadcn-style
 * table/field structure). No motion except the skeleton pulse, which is gated
 * behind `motion-safe` and also switched off by the global reduced-motion rule.
 */
import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { labels, type LangMode, type MessageKey } from '@/lib/i18n';

/** One label per language. In "both" mode the second line is a little smaller. */
export function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </>
  );
}

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, 2 px focus ring. */
export const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const PRIMARY_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-base font-medium text-primary-foreground transition-colors duration-100 hover:bg-primary/90 disabled:opacity-60 sm:w-auto';
export const OUTLINE_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-4 text-base font-medium text-foreground transition-colors duration-100 hover:bg-background disabled:opacity-60 sm:w-auto';
export const CARD = 'rounded-[10px] border border-border bg-card';

/** `YYYY-MM-DD` in UTC, the same zone the alerts screen uses. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The page title block: h1, one hint line, and an optional chip on the right. */
export function PageHeader({
  title,
  hint,
  aside,
}: {
  title: ReactNode;
  hint?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold">{title}</h1>
        {hint ? <p className="max-w-[60ch] text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {aside}
    </header>
  );
}

type Tone = 'success' | 'danger' | 'warn' | 'info' | 'neutral';

const CHIP_TONE: Record<Tone, string> = {
  success: 'border-correct-icon bg-correct-soft text-correct',
  danger: 'border-wrong-icon bg-wrong-soft text-wrong',
  // Amber on white only: amber on its own tint measures under 4.5:1.
  warn: 'border-marked bg-card text-marked',
  info: 'border-primary bg-primary/10 text-primary',
  neutral: 'border-border bg-background text-muted-foreground',
};

/** A status pill. 12 px is allowed for badges only (DESIGN.md section 4). */
export function Chip({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={
        'inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs leading-4 font-medium whitespace-nowrap ' +
        CHIP_TONE[tone]
      }
    >
      {icon}
      {children}
    </span>
  );
}

const BANNER_TONE: Record<'success' | 'error' | 'info', string> = {
  success: 'border-correct-icon bg-correct-soft text-correct',
  error: 'border-wrong-icon bg-wrong-soft text-wrong',
  info: 'border-border bg-card text-muted-foreground',
};

/**
 * A message strip with an icon. Success and info use `role="status"`, an error
 * uses `role="alert"`; the caller passes the role so a test or reader finds it.
 */
export function Banner({
  tone,
  role,
  children,
}: {
  tone: 'success' | 'error' | 'info';
  role: 'status' | 'alert';
  children: ReactNode;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertCircle : Info;
  return (
    <p
      role={role}
      className={
        'flex items-start gap-2 rounded-[10px] border p-3 text-base font-medium ' +
        BANNER_TONE[tone]
      }
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A grey block the shape of the content that is coming. */
export function SkeletonBlock({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={'rounded-[10px] bg-border motion-safe:animate-pulse ' + className}
    />
  );
}

/** The empty state: one icon, one line (DESIGN.md section 9). */
export function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      role="status"
      className={CARD + ' flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground'}
    >
      <span aria-hidden="true" className="text-muted-foreground">
        {icon}
      </span>
      <p className="text-base">{children}</p>
    </div>
  );
}
