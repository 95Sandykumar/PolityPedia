'use client';

/**
 * Admin screen: teacher payouts (issue 29-ledger-reconcile-payouts).
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
 * rounded would disagree with the ledger by a few paise a month forever.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: the real gate is the `is_admin()` check inside `payout_report()`
 * and `mark_payout_paid()`. This form is convenience, not permission, and it
 * shows one fixed failure message so a policy name never reaches the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBrowserPayoutsClient } from '@/lib/ledger/browser-payouts-client';
import { payoutRupees, type BrowserPayoutsClient, type PayoutLine } from '@/lib/ledger/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';

function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
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

/** One row of the report. `period` + `teacherId` is its key: one transfer. */
function lineKey(line: PayoutLine): string {
  return line.teacherId + '\u0000' + line.period;
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

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="payouts.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('payouts.notConfigured', mode)}
        </p>
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

  return (
    <section className="flex flex-col gap-3">
      {title}
      <p className="text-sm text-muted-foreground">{plain('payouts.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain(failed === 'failed' ? 'payouts.failed' : 'payouts.readFailed', mode)}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain(done === 'paid' ? 'payouts.paid' : 'payouts.nothingOwed', mode)}
        </p>
      ) : null}

      {lines === null && !failed ? (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          {plain('payouts.loading', mode)}
        </p>
      ) : null}

      {lines !== null && lines.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain('payouts.empty', mode)}
        </p>
      ) : null}

      {lines !== null && lines.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {lines.map((line) => {
            const key = lineKey(line);
            return (
              <li
                key={key}
                className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-muted-foreground">
                    {plain('payouts.month', mode)}
                  </span>
                  <span className="text-base font-medium tabular-nums">{line.period}</span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-muted-foreground">
                    {plain('payouts.teacher', mode)}
                  </span>
                  {/* The id, not a name: this screen is a bank worksheet, and
                      a teacher's real name may be hidden behind an alias. */}
                  <span className="font-mono text-sm break-all">{line.teacherId}</span>
                </div>

                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-muted-foreground">
                    {plain('payouts.sales', mode)}
                  </span>
                  <span className="text-base tabular-nums">{line.saleCount}</span>
                </div>

                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-muted-foreground">
                    {plain('payouts.owed', mode)}
                  </span>
                  <span className="text-[18px] leading-6 font-bold tabular-nums">
                    {payoutRupees(line.amountInr, lang)}
                  </span>
                </div>

                <label htmlFor={'payout-ref-' + key} className="text-sm font-medium">
                  <Lines keyName="payouts.reference" mode={mode} />
                </label>
                <input
                  id={'payout-ref-' + key}
                  name="reference"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={references[key] ?? ''}
                  onChange={(event) =>
                    setReferences((all) => ({ ...all, [key]: event.target.value }))
                  }
                  className={FIELD + ' font-mono text-sm'}
                />

                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void markPaid(line)}
                  aria-label={plain('payouts.markPaid', mode)}
                  className={PRIMARY_BUTTON}
                >
                  {plain(busy === key ? 'payouts.paying' : 'payouts.markPaid', mode)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
