'use client';

/**
 * Admin screen: teacher payouts (issue 29-ledger-reconcile-payouts, laid out
 * again in the admin-ui pass).
 *
 * X1: "Monthly manual bank transfer from the `teacher_ledger` report." This is
 * that report plus the one button that records the transfer. It does NOT move
 * money: Boss makes the bank transfer by hand, then presses Mark paid so the
 * sale leaves the owed list and the teacher's dashboard shows the payout.
 *
 * ONE LINE PER TEACHER PER MONTH, because that is one bank transfer. The
 * amount is the teacher's half only (`teacher_amount`), already worked out at
 * sale time by 0027 with the share copied, so a share change never rewrites an
 * old month.
 *
 * The amount is rendered to the PAISA and never rounded for display. A number
 * on this screen is a number Boss types into a bank, and a display that
 * rounded would disagree with the ledger by a few paise a month forever. The
 * summary total is added up in whole paise for the same reason.
 *
 * The month selector only FILTERS what is on screen. It never hides money
 * silently: the default is "All months", and the summary always counts exactly
 * the lines that are shown.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: the real gate is the `is_admin()` check inside `payout_report()`
 * and `mark_payout_paid()`. This form is convenience, not permission, and it
 * shows one fixed failure message so a policy name never reaches the page.
 *
 * Source: hand-built from DESIGN.md tokens. Semantic `<table>` inside its own
 * scroll region; the skeleton pulse is `motion-safe` only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Wallet } from 'lucide-react';
import { createBrowserPayoutsClient } from '@/lib/ledger/browser-payouts-client';
import { payoutRupees, type BrowserPayoutsClient, type PayoutLine } from '@/lib/ledger/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';
import {
  Banner,
  CARD,
  EmptyState,
  FIELD,
  Lines,
  PageHeader,
  PRIMARY_BUTTON,
  SkeletonBlock,
} from '@/components/admin-ui';

const ALL = 'all';

/** One row of the report. `period` + `teacherId` is its key: one transfer. */
function lineKey(line: PayoutLine): string {
  return line.teacherId + '\u0000' + line.period;
}

/** `2026-10` as "October 2026" (or the raw text if it is not a month). */
function monthName(period: string, lang: 'en' | 'hi'): string {
  const at = new Date(period + '-01T00:00:00Z');
  if (Number.isNaN(at.getTime())) return period;
  try {
    return new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN-u-nu-latn' : 'en-IN', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(at);
  } catch {
    return period;
  }
}

function Stat({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={CARD + ' flex flex-col gap-1 p-3 ' + className}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="text-[22px] leading-7 font-bold tabular-nums">{children}</span>
    </div>
  );
}

/** The loading shape: summary strip plus a few table rows. */
function PayoutsSkeleton({ mode }: { mode: LangMode }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{plain('payouts.loading', mode)}</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SkeletonBlock className="col-span-2 h-[76px] sm:col-span-1" />
        <SkeletonBlock className="h-[76px]" />
        <SkeletonBlock className="h-[76px]" />
      </div>
      <div className={CARD + ' flex flex-col gap-3 p-3'}>
        {[0, 1, 2, 3].map((row) => (
          <SkeletonBlock key={row} className="h-12" />
        ))}
      </div>
    </div>
  );
}

export function AdminPayoutsForm({
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  client?: BrowserPayoutsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserPayoutsClient(), []);
  const payouts = client ?? fallback;

  const [lines, setLines] = useState<PayoutLine[] | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [month, setMonth] = useState<string>(ALL);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<'paid' | 'nothingOwed' | null>(null);
  const [failed, setFailed] = useState<'failed' | 'readFailed' | null>(null);

  const load = useCallback(async () => {
    try {
      setLines(await payouts.list());
      setFailed(null);
    } catch {
      // An empty list would read as "nothing owed", so a failed read says so
      // out loud and leaves the table off the screen entirely.
      setLines(null);
      setFailed('readFailed');
    }
  }, [payouts]);

  useEffect(() => {
    if (!configured) return;
    void load();
  }, [configured, load]);

  const periods = useMemo(
    () => [...new Set((lines ?? []).map((line) => line.period))].sort().reverse(),
    [lines],
  );
  // A month that has just been paid off leaves the list; fall back to all.
  const activeMonth = periods.includes(month) ? month : ALL;
  const shown = useMemo(
    () => (lines ?? []).filter((line) => activeMonth === ALL || line.period === activeMonth),
    [lines, activeMonth],
  );

  const title = <Lines keyName="payouts.title" mode={mode} />;

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Banner tone="info" role="status">
          {plain('payouts.notConfigured', mode)}
        </Banner>
      </section>
    );
  }

  async function markPaid(line: PayoutLine) {
    const key = lineKey(line);
    if (busy) return;
    setBusy(key);
    setFailed(null);
    setDone(null);
    try {
      const result = await payouts.markPaid({
        teacherId: line.teacherId,
        period: line.period,
        reference: references[key] ?? null,
      });
      // A null id means nothing was owed after all: somebody else paid this
      // month between the read and the press. Say that, do not claim a payout.
      setDone(result.payoutId ? 'paid' : 'nothingOwed');
      // Re-read, so the line leaves the owed list from the database and not
      // from an assumption about what the press did.
      await load();
    } catch {
      // Fixed message only: the thrown error may quote Postgres.
      setFailed('failed');
    } finally {
      setBusy(null);
    }
  }

  const lang: 'en' | 'hi' = mode === 'hi' ? 'hi' : 'en';
  // Whole paise, so the total can never drift from the lines above it.
  const totalPaise = shown.reduce((sum, line) => sum + Math.round(line.amountInr * 100), 0);
  const totalSales = shown.reduce((sum, line) => sum + line.saleCount, 0);

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={title} hint={plain('payouts.hint', mode)} />

      {failed ? (
        <Banner tone="error" role="alert">
          {plain(failed === 'failed' ? 'payouts.failed' : 'payouts.readFailed', mode)}
        </Banner>
      ) : null}

      {done ? (
        <Banner tone="success" role="status">
          {plain(done === 'paid' ? 'payouts.paid' : 'payouts.nothingOwed', mode)}
        </Banner>
      ) : null}

      {lines === null && !failed ? <PayoutsSkeleton mode={mode} /> : null}

      {lines !== null && lines.length === 0 ? (
        <EmptyState icon={<Wallet className="size-8" />}>{plain('payouts.empty', mode)}</EmptyState>
      ) : null}

      {lines !== null && lines.length > 0 ? (
        <>
          <div className="flex flex-col gap-1 sm:max-w-xs">
            <label htmlFor="payouts-month" className="text-sm font-medium">
              <Lines keyName="adminPayouts.filter" mode={mode} />
            </label>
            <select
              id="payouts-month"
              value={activeMonth}
              onChange={(event) => setMonth(event.target.value)}
              className={FIELD}
            >
              <option value={ALL}>{plain('adminPayouts.allMonths', mode)}</option>
              {periods.map((period) => (
                <option key={period} value={period}>
                  {monthName(period, lang)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={plain('adminPayouts.totalOwed', mode)} className="col-span-2 sm:col-span-1">
              {payoutRupees(totalPaise / 100, lang)}
            </Stat>
            <Stat label={plain('payouts.sales', mode)}>{totalSales}</Stat>
            <Stat label={plain('adminPayouts.transfers', mode)}>{shown.length}</Stat>
          </div>

          {/* tabIndex 0 so a keyboard user can scroll the table sideways. */}
          <div
            role="region"
            aria-label={plain('adminPayouts.tableLabel', mode)}
            tabIndex={0}
            // `relative` makes this box the containing block of the sr-only
            // labels inside it, so they are clipped here and cannot stretch
            // the page sideways.
            className={CARD + ' relative overflow-x-auto'}
          >
            <table className="w-full min-w-[900px] border-collapse text-left">
              <caption className="sr-only">{plain('adminPayouts.tableLabel', mode)}</caption>
              <thead>
                <tr className="border-b border-border bg-background text-sm text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    {plain('payouts.month', mode)}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {plain('payouts.teacher', mode)}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {plain('payouts.sales', mode)}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {plain('payouts.owed', mode)}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {plain('payouts.reference', mode)}
                  </th>
                  <th
                    scope="col"
                    className="sticky right-0 border-l border-border bg-background px-3 py-2 font-medium"
                  >
                    {plain('adminPayouts.action', mode)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((line) => {
                  const key = lineKey(line);
                  return (
                    <tr key={key} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-3 text-base font-medium tabular-nums">{line.period}</td>
                      <td className="px-3 py-3">
                        {/* The id, not a name: this screen is a bank worksheet,
                            and a teacher's real name may be hidden behind an
                            alias. Cut short by CSS only, the full id is still
                            the text (copy, search, screen reader). */}
                        <span
                          title={line.teacherId}
                          className="block max-w-[12rem] truncate font-mono text-xs"
                        >
                          {line.teacherId}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-base tabular-nums">
                        {line.saleCount}
                      </td>
                      <td className="px-3 py-3 text-right text-[18px] leading-6 font-bold tabular-nums">
                        {payoutRupees(line.amountInr, lang)}
                      </td>
                      <td className="px-3 py-2">
                        <label htmlFor={'payout-ref-' + key} className="sr-only">
                          <Lines keyName="payouts.reference" mode={mode} />
                        </label>
                        <input
                          id={'payout-ref-' + key}
                          name="reference"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={plain('adminPayouts.refPlaceholder', mode)}
                          value={references[key] ?? ''}
                          onChange={(event) =>
                            setReferences((all) => ({ ...all, [key]: event.target.value }))
                          }
                          className={FIELD + ' w-64 font-mono text-sm'}
                        />
                      </td>
                      <td className="sticky right-0 border-l border-border bg-card px-3 py-2">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void markPaid(line)}
                          aria-label={plain('payouts.markPaid', mode)}
                          className={PRIMARY_BUTTON + ' whitespace-nowrap'}
                        >
                          <Check aria-hidden="true" className="size-5" />
                          {plain(busy === key ? 'payouts.paying' : 'payouts.markPaid', mode)}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground lg:hidden">
            {plain('adminPayouts.scrollHint', mode)}
          </p>
        </>
      ) : null}
    </section>
  );
}
