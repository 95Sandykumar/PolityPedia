/**
 * Issue 38-session-and-alerts-fixes: /admin/alerts was hiding the webhook
 * alerts.
 *
 * `0034` writes `currency_mismatch`, `plan_mismatch` and `bad_event` into the
 * SAME `reconcile_alerts` table, and `0035` lists all three in
 * `reconcile_alerts_kind_check`. The readers knew only the nightly job's five,
 * so `readAlertRow` returned null for a refused payment and the row was
 * DROPPED: the page never showed it and the badge on the Admin home counted
 * one fewer than there were. The worst case is the loudest one: money arrived
 * in the wrong currency and nobody was told.
 *
 * Two rules here:
 *
 *  1. All eight kinds render, in English and in Hindi, and all eight count.
 *  2. A kind this build has never heard of renders as a GENERIC row with the
 *     raw kind text, instead of vanishing. The database may be one migration
 *     ahead of the deployed build, and an alert about money must survive that.
 *
 * The clients are faked, so there is no network call and no key.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminAlertsList } from '../admin-alerts-list';
import { AdminOpenAlertsCount } from '../admin-open-alerts-count';
import { t } from '@/lib/i18n';
import { createBrowserAlertsClient } from '@/lib/ledger/browser-alerts-client';
import { createSupabaseAlertsClient } from '@/lib/ledger/supabase-alerts-client';
import {
  RECONCILE_KINDS,
  isReconcileKind,
  type BrowserAlertsClient,
  type ReconcileAlertRow,
} from '@/lib/ledger/types';

const ID = '22222222-2222-4222-8222-222222222222';
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

function row(values: Partial<ReconcileAlertRow> = {}): ReconcileAlertRow {
  return {
    id: ID,
    kind: 'currency_mismatch',
    subject: 'pay_Wrong123',
    orderId: 'order_Wrong123',
    expectedPaise: 39_900,
    actualPaise: 39_900,
    createdAtIso: '2026-11-05T02:00:00.000Z',
    ...values,
  };
}

function uuid(n: number): string {
  const digit = String(n % 10).repeat(8);
  return `${digit}-2222-4222-8222-222222222222`;
}

function fakeClient(alerts: readonly ReconcileAlertRow[]): BrowserAlertsClient {
  return {
    async list() {
      return [...alerts];
    },
    async resolve() {
      return true;
    },
  };
}

/** A PostgREST reply with one row, as the server client really reads it. */
function restReply(kind: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify([
        {
          id: ID,
          kind,
          subject: 'pay_Wrong123',
          order_id: 'order_Wrong123',
          expected_paise: 39_900,
          actual_paise: 39_900,
          created_at: '2026-11-05T02:00:00.000Z',
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('the kind list matches the database', () => {
  it('holds all eight kinds the check constraint allows', () => {
    expect([...RECONCILE_KINDS]).toEqual([
      'no_purchase',
      'not_paid',
      'amount_mismatch',
      'no_payment',
      'currency_mismatch',
      'plan_mismatch',
      'bad_event',
      'unreadable_purchase',
    ]);
  });

  it('knows its own kinds and nothing else', () => {
    expect(isReconcileKind('bad_event')).toBe(true);
    expect(isReconcileKind('something_new')).toBe(false);
    expect(isReconcileKind(7)).toBe(false);
  });
});

describe('the three webhook kinds reach the screen', () => {
  for (const kind of ['currency_mismatch', 'plan_mismatch', 'bad_event'] as const) {
    it(`the server client keeps a ${kind} row instead of dropping it`, async () => {
      const client = createSupabaseAlertsClient({
        accessToken: 'admin.token',
        env: ENV,
        fetchImpl: restReply(kind),
      });
      const rows = await client.listOpen();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe(kind);
    });

    it(`the browser client keeps a ${kind} row instead of dropping it`, async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ alerts: [row({ kind })] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;

      const rows = await createBrowserAlertsClient(fetchImpl).list();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe(kind);
    });
  }

  it('draws the English words for a currency mismatch', async () => {
    render(<AdminAlertsList client={fakeClient([row({ kind: 'currency_mismatch' })])} mode="en" />);
    expect(await screen.findByText(t('alerts.kindCurrencyMismatch', 'en'))).toBeInTheDocument();
    expect(screen.getByText(t('alerts.detailCurrencyMismatch', 'en'))).toBeInTheDocument();
  });

  it('draws the Hindi words for a plan mismatch', async () => {
    render(<AdminAlertsList client={fakeClient([row({ kind: 'plan_mismatch' })])} mode="hi" />);
    expect(await screen.findByText(t('alerts.kindPlanMismatch', 'hi'))).toBeInTheDocument();
    expect(screen.getByText(t('alerts.detailPlanMismatch', 'hi'))).toBeInTheDocument();
  });

  it('draws a bad event in both languages at once', async () => {
    render(<AdminAlertsList client={fakeClient([row({ kind: 'bad_event' })])} mode="both" />);
    expect(await screen.findByText(t('alerts.kindBadEvent', 'en'))).toBeInTheDocument();
    expect(screen.getByText(t('alerts.kindBadEvent', 'hi'))).toBeInTheDocument();
  });

  it('has English AND Hindi words for every kind (web/CLAUDE.md)', async () => {
    const rows = RECONCILE_KINDS.map((kind, index) => row({ id: uuid(index), kind }));
    render(<AdminAlertsList client={fakeClient(rows)} mode="hi" />);

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(rows.length));
    // Nothing fell back to the generic row: every kind has its own words.
    expect(screen.queryByText(t('alerts.kindUnknown', 'hi'))).toBeNull();
  });
});

describe('a kind this build has never heard of', () => {
  it('is kept by the server client, not dropped', async () => {
    const client = createSupabaseAlertsClient({
      accessToken: 'admin.token',
      env: ENV,
      fetchImpl: restReply('settlement_missing'),
    });
    const rows = await client.listOpen();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('settlement_missing');
  });

  it('renders as a generic row that shows the raw kind text', async () => {
    render(<AdminAlertsList client={fakeClient([row({ kind: 'settlement_missing' })])} mode="en" />);

    expect(await screen.findByText(t('alerts.kindUnknown', 'en'))).toBeInTheDocument();
    expect(screen.getByText('settlement_missing')).toBeInTheDocument();
    expect(screen.getByText(t('alerts.detailUnknown', 'en'))).toBeInTheDocument();
    // Still one real row with its amount, not a half-drawn one.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('is still dropped when the kind is empty or absurdly long', async () => {
    for (const kind of ['', 'x'.repeat(200)]) {
      const client = createSupabaseAlertsClient({
        accessToken: 'admin.token',
        env: ENV,
        fetchImpl: restReply(kind),
      });
      expect(await client.listOpen()).toHaveLength(0);
    }
  });
});

describe('the badge on the Admin home', () => {
  it('counts the webhook kinds too', async () => {
    const rows = [
      row({ id: uuid(1), kind: 'currency_mismatch' }),
      row({ id: uuid(2), kind: 'plan_mismatch' }),
      row({ id: uuid(3), kind: 'bad_event' }),
    ];
    render(<AdminOpenAlertsCount client={fakeClient(rows)} mode="en" />);

    expect(await screen.findByText('3')).toBeInTheDocument();
  });

  it('counts a kind it cannot name, because the money is still missing', async () => {
    render(
      <AdminOpenAlertsCount client={fakeClient([row({ kind: 'settlement_missing' })])} mode="en" />,
    );
    expect(await screen.findByText('1')).toBeInTheDocument();
  });
});
