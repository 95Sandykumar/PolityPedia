'use client';

/**
 * Admin screen: money alerts (issue 35-reconcile-visible).
 *
 * design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
 * mismatch -> alert." Issue 29 wrote the alerts. THIS is the first thing that
 * reads them: before this screen a money problem found at 2 AM sat in a table
 * nobody opened, with no admin page and no push message.
 *
 * ONE LINE PER DISTINCT PROBLEM, because `(kind, subject)` is UNIQUE in
 * Postgres (0029). The job keeps seeing the same ghost payment every night and
 * Boss still sees one line about it.
 *
 * Three rules, and all three are money:
 *
 *  1. A failed read must NOT look like an empty list. "Nothing open" and
 *     "could not load" are opposite answers.
 *  2. The amount is drawn to the PAISA from the paise the table stores, and a
 *     side with no amount shows a hyphen, never Rs 0.00: "no payment at all"
 *     and "a payment of nothing" are different problems.
 *  3. Resolved RE-READS the list from the database afterwards, so the row
 *     leaves because Postgres says so and not because a button was tapped.
 *
 * The client is a prop so the test can inject a fake: no real network call and
 * no real key in any test (web/CLAUDE.md).
 *
 * Security: the real gate is the `reconcile_alerts_admin_all` policy in 0029,
 * evaluated against the admin's own token. This screen is convenience, not
 * permission, and it shows one fixed failure message so a policy name never
 * reaches the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBrowserAlertsClient } from '@/lib/ledger/browser-alerts-client';
import {
  alertRupees,
  type BrowserAlertsClient,
  type ReconcileAlertRow,
  type ReconcileKind,
} from '@/lib/ledger/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const SECONDARY_BUTTON =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 disabled:opacity-60';

/** One kind, two labels: what it is, and what Boss does about it. */
const KIND_LABELS: Record<ReconcileKind, { name: MessageKey; detail: MessageKey }> = {
  no_purchase: { name: 'alerts.kindNoPurchase', detail: 'alerts.detailNoPurchase' },
  not_paid: { name: 'alerts.kindNotPaid', detail: 'alerts.detailNotPaid' },
  amount_mismatch: { name: 'alerts.kindAmountMismatch', detail: 'alerts.detailAmountMismatch' },
  no_payment: { name: 'alerts.kindNoPayment', detail: 'alerts.detailNoPayment' },
  unreadable_purchase: {
    name: 'alerts.kindUnreadablePurchase',
    detail: 'alerts.detailUnreadablePurchase',
  },
};

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

/**
 * The day the job found it, as `YYYY-MM-DD HH:MM` in UTC.
 *
 * UTC and not the browser's zone on purpose: Boss matches this against a
 * Razorpay dashboard and a PM2 log, and both of those are read in one fixed
 * zone. A locale-formatted date would also differ between the server render
 * and the browser.
 */
function foundAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function Field({
  label,
  mode,
  children,
}: {
  label: MessageKey;
  mode: LangMode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">{plain(label, mode)}</span>
      {children}
    </div>
  );
}

export function AdminAlertsList({
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  client?: BrowserAlertsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserAlertsClient(), []);
  const alerts = client ?? fallback;

  const [rows, setRows] = useState<ReconcileAlertRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<'resolvedOne' | 'alreadyResolved' | null>(null);
  const [failed, setFailed] = useState<'failed' | 'readFailed' | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await alerts.list());
      setFailed(null);
    } catch {
      // An empty list would read as "nothing is wrong", so a failed read says
      // so out loud and leaves the list off the screen entirely.
      setRows(null);
      setFailed('readFailed');
    }
  }, [alerts]);

  useEffect(() => {
    if (!configured) return;
    void load();
  }, [configured, load]);

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="alerts.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('alerts.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function resolve(row: ReconcileAlertRow) {
    if (busy) return;
    setBusy(row.id);
    setFailed(null);
    setDone(null);
    try {
      // FALSE is a real answer: another admin resolved it between the read and
      // the press. Say that rather than claiming this press did it.
      setDone((await alerts.resolve(row.id)) ? 'resolvedOne' : 'alreadyResolved');
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
      <p className="text-sm text-muted-foreground">{plain('alerts.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain(failed === 'failed' ? 'alerts.failed' : 'alerts.readFailed', mode)}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain(done === 'resolvedOne' ? 'alerts.resolvedOne' : 'alerts.alreadyResolved', mode)}
        </p>
      ) : null}

      {rows === null && !failed ? (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          {plain('alerts.loading', mode)}
        </p>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain('alerts.empty', mode)}
        </p>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3"
            >
              <Field label="alerts.kind" mode={mode}>
                <span className="text-base font-bold">
                  <Lines keyName={KIND_LABELS[row.kind].name} mode={mode} />
                </span>
              </Field>

              <Field label="alerts.when" mode={mode}>
                <span className="text-base tabular-nums">{foundAt(row.createdAtIso)}</span>
              </Field>

              <Field label="alerts.payment" mode={mode}>
                {/* The id, not a name. It is what a human looks the problem
                    up by at Razorpay, and nobody's email belongs here. */}
                <span className="font-mono text-sm break-all">{row.subject}</span>
              </Field>

              {row.orderId ? (
                <Field label="alerts.order" mode={mode}>
                  <span className="font-mono text-sm break-all">{row.orderId}</span>
                </Field>
              ) : null}

              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-muted-foreground">
                  {plain('alerts.expected', mode)}
                </span>
                <span className="text-base tabular-nums">
                  {alertRupees(row.expectedPaise, lang)}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-muted-foreground">
                  {plain('alerts.actual', mode)}
                </span>
                <span className="text-[18px] leading-6 font-bold tabular-nums">
                  {alertRupees(row.actualPaise, lang)}
                </span>
              </div>

              <Field label="alerts.detail" mode={mode}>
                <span className="text-sm">
                  <Lines keyName={KIND_LABELS[row.kind].detail} mode={mode} />
                </span>
              </Field>

              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void resolve(row)}
                aria-label={plain('alerts.resolve', mode)}
                className={SECONDARY_BUTTON}
              >
                {plain(busy === row.id ? 'alerts.resolving' : 'alerts.resolve', mode)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
