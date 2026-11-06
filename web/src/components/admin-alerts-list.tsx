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
import { CalendarClock, Check, ListChecks, ShieldAlert, ShieldCheck } from 'lucide-react';
import { createBrowserAlertsClient } from '@/lib/ledger/browser-alerts-client';
import {
  alertRupees,
  isReconcileKind,
  type BrowserAlertsClient,
  type ReconcileAlertRow,
  type ReconcileKind,
} from '@/lib/ledger/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import {
  Banner,
  CARD,
  Chip,
  EmptyState,
  Lines,
  OUTLINE_BUTTON,
  PageHeader,
  SkeletonBlock,
} from '@/components/admin-ui';

type Severity = 'high' | 'medium' | 'low';

/**
 * How loud a kind is. HIGH: money moved with no matching sale of ours, or the
 * two amounts or currencies disagree, or a charge landed on a plan that is
 * unknown or stopped. MEDIUM: a state to look at. LOW: an event we can never
 * accept, which is noise to read once. A kind this build does not know is
 * MEDIUM: never hide it, never shout about it.
 */
const SEVERITY: Record<ReconcileKind, Severity> = {
  no_purchase: 'high',
  not_paid: 'medium',
  amount_mismatch: 'high',
  no_payment: 'high',
  currency_mismatch: 'high',
  plan_mismatch: 'medium',
  bad_event: 'low',
  unreadable_purchase: 'medium',
  unknown_subscription: 'high',
  cancelled_subscription: 'high',
};

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  high: 'adminAlerts.sevHigh',
  medium: 'adminAlerts.sevMedium',
  low: 'adminAlerts.sevLow',
};

function severityOf(kind: string): Severity {
  return isReconcileKind(kind) ? SEVERITY[kind] : 'medium';
}

/**
 * One kind, two labels: what it is, and what Boss does about it.
 *
 * All TEN kinds `reconcile_alerts_kind_check` allows, not five. The three
 * the webhook writes (0034) were missing until
 * issue 38-session-and-alerts-fixes, and a missing entry here crashed the row
 * rather than drawing it. The last two are the subscription charges that used
 * to be dropped in silence (0039, issue 40-charge-alerts).
 */
const KIND_LABELS: Record<ReconcileKind, { name: MessageKey; detail: MessageKey }> = {
  no_purchase: { name: 'alerts.kindNoPurchase', detail: 'alerts.detailNoPurchase' },
  not_paid: { name: 'alerts.kindNotPaid', detail: 'alerts.detailNotPaid' },
  amount_mismatch: { name: 'alerts.kindAmountMismatch', detail: 'alerts.detailAmountMismatch' },
  no_payment: { name: 'alerts.kindNoPayment', detail: 'alerts.detailNoPayment' },
  currency_mismatch: {
    name: 'alerts.kindCurrencyMismatch',
    detail: 'alerts.detailCurrencyMismatch',
  },
  plan_mismatch: { name: 'alerts.kindPlanMismatch', detail: 'alerts.detailPlanMismatch' },
  bad_event: { name: 'alerts.kindBadEvent', detail: 'alerts.detailBadEvent' },
  unreadable_purchase: {
    name: 'alerts.kindUnreadablePurchase',
    detail: 'alerts.detailUnreadablePurchase',
  },
  unknown_subscription: {
    name: 'alerts.kindUnknownSubscription',
    detail: 'alerts.detailUnknownSubscription',
  },
  cancelled_subscription: {
    name: 'alerts.kindCancelledSubscription',
    detail: 'alerts.detailCancelledSubscription',
  },
};

/** The words for a kind, or the GENERIC pair when this build has none. */
const UNKNOWN_LABELS = { name: 'alerts.kindUnknown', detail: 'alerts.detailUnknown' } as const;

function kindLabels(kind: string): { name: MessageKey; detail: MessageKey } {
  return isReconcileKind(kind) ? KIND_LABELS[kind] : UNKNOWN_LABELS;
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

  const title = <Lines keyName="alerts.title" mode={mode} />;

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Banner tone="info" role="status">
          {plain('alerts.notConfigured', mode)}
        </Banner>
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
    <section className="flex flex-col gap-4">
      <PageHeader
        title={title}
        hint={plain('alerts.hint', mode)}
        aside={
          rows !== null && rows.length > 0 ? (
            <Chip tone="danger" icon={<ShieldAlert aria-hidden="true" className="size-3.5" />}>
              <span className="tabular-nums">{rows.length}</span> {plain('alerts.open', mode)}
            </Chip>
          ) : null
        }
      />

      {failed ? (
        <Banner tone="error" role="alert">
          {plain(failed === 'failed' ? 'alerts.failed' : 'alerts.readFailed', mode)}
        </Banner>
      ) : null}

      {done ? (
        <Banner tone="success" role="status">
          {plain(done === 'resolvedOne' ? 'alerts.resolvedOne' : 'alerts.alreadyResolved', mode)}
        </Banner>
      ) : null}

      {rows === null && !failed ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">{plain('alerts.loading', mode)}</span>
          <SkeletonBlock className="h-[260px]" />
        </div>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="size-8" />}>
          {plain('alerts.empty', mode)}
        </EmptyState>
      ) : null}

      {rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const severity = severityOf(row.kind);
            const differ = row.expectedPaise !== row.actualPaise;
            return (
              <li key={row.id} className={CARD + ' flex flex-col'}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Chip
                      tone={
                        severity === 'high' ? 'danger' : severity === 'medium' ? 'warn' : 'neutral'
                      }
                      icon={<ShieldAlert aria-hidden="true" className="size-3.5" />}
                    >
                      {plain(SEVERITY_KEY[severity], mode)}
                    </Chip>
                    <span className="min-w-0 text-lg leading-6 font-bold">
                      <Lines keyName={kindLabels(row.kind).name} mode={mode} />
                    </span>
                  </div>
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <CalendarClock aria-hidden="true" className="size-4" />
                    <span className="sr-only">{plain('alerts.when', mode)}</span>
                    <span className="tabular-nums">{foundAt(row.createdAtIso)}</span>
                  </span>
                </div>

                <div className="grid gap-3 p-3 lg:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-background p-3">
                        <span className="text-sm font-medium text-muted-foreground">
                          {plain('alerts.expected', mode)}
                        </span>
                        <span className="text-[22px] leading-7 font-bold tabular-nums">
                          {alertRupees(row.expectedPaise, lang)}
                        </span>
                      </div>
                      <div
                        className={
                          'flex flex-col gap-1 rounded-[10px] border p-3 ' +
                          (differ
                            ? 'border-wrong-icon bg-wrong-soft text-wrong'
                            : 'border-border bg-background')
                        }
                      >
                        <span
                          className={
                            'text-sm font-medium ' +
                            (differ ? 'text-wrong' : 'text-muted-foreground')
                          }
                        >
                          {plain('alerts.actual', mode)}
                        </span>
                        <span className="text-[22px] leading-7 font-bold tabular-nums">
                          {alertRupees(row.actualPaise, lang)}
                        </span>
                      </div>
                    </div>

                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">{plain('alerts.payment', mode)}</dt>
                      {/* The id, not a name. It is what a human looks the
                          problem up by at Razorpay, and nobody's email belongs
                          here. */}
                      <dd className="font-mono text-xs break-all">{row.subject}</dd>
                      {row.orderId ? (
                        <>
                          <dt className="text-muted-foreground">{plain('alerts.order', mode)}</dt>
                          <dd className="font-mono text-xs break-all">{row.orderId}</dd>
                        </>
                      ) : null}
                      {/* The raw text, for a kind a newer migration added.
                          Boss can read it out to the developer; without it the
                          row would be a problem with no name. */}
                      {isReconcileKind(row.kind) ? null : (
                        <>
                          <dt className="text-muted-foreground">
                            {plain('alerts.kindRaw', mode)}
                          </dt>
                          <dd className="font-mono text-xs break-all">{row.kind}</dd>
                        </>
                      )}
                    </dl>
                  </div>

                  <div className="flex gap-3 rounded-[10px] border border-l-4 border-border border-l-primary bg-background p-3">
                    <ListChecks
                      aria-hidden="true"
                      className="mt-0.5 size-5 shrink-0 text-primary"
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-bold">{plain('alerts.detail', mode)}</span>
                      <span className="text-base">
                        <Lines keyName={kindLabels(row.kind).detail} mode={mode} />
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border p-3">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void resolve(row)}
                    aria-label={plain('alerts.resolve', mode)}
                    className={OUTLINE_BUTTON}
                  >
                    <Check aria-hidden="true" className="size-5" />
                    {plain(busy === row.id ? 'alerts.resolving' : 'alerts.resolve', mode)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
