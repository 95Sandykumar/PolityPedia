/**
 * Issue 40-charge-alerts: the two kinds the DROPPED charge files.
 *
 * `charge_subscription()` used to return FALSE with no alert when the
 * subscription id was unknown or the subscription was already cancelled, and
 * its de-dupe row was already committed, so Razorpay's retry bought nothing
 * either. 0039 files `unknown_subscription` and `cancelled_subscription` for
 * those two, and a kind with no words on the screen would be a generic row:
 * money is missing and the page would not say which kind of missing.
 *
 * Same two rules as issue 38's `alert-kinds.test.tsx`: both kinds render in
 * English and in Hindi, and both count in the badge on the Admin home.
 *
 * The clients are faked, so there is no network call and no key.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminAlertsList } from '../admin-alerts-list';
import { AdminOpenAlertsCount } from '../admin-open-alerts-count';
import { t } from '@/lib/i18n';
import {
  RECONCILE_KINDS,
  isReconcileKind,
  type BrowserAlertsClient,
  type ReconcileAlertRow,
} from '@/lib/ledger/types';

const ID = '33333333-3333-4333-8333-333333333333';

/** The two kinds 0039 adds, with the label keys the screen must own. */
const NEW_KINDS = [
  {
    kind: 'unknown_subscription',
    name: 'alerts.kindUnknownSubscription',
    detail: 'alerts.detailUnknownSubscription',
  },
  {
    kind: 'cancelled_subscription',
    name: 'alerts.kindCancelledSubscription',
    detail: 'alerts.detailCancelledSubscription',
  },
] as const;

function row(values: Partial<ReconcileAlertRow> = {}): ReconcileAlertRow {
  return {
    id: ID,
    kind: 'unknown_subscription',
    subject: 'charged:pay_Ghost123',
    orderId: null,
    expectedPaise: null,
    actualPaise: 39_900,
    createdAtIso: '2026-11-06T02:00:00.000Z',
    ...values,
  };
}

function uuid(n: number): string {
  const digit = String(n % 10).repeat(8);
  return `${digit}-3333-4333-8333-333333333333`;
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

describe('the kind list knows the two charge kinds', () => {
  it('holds all ten kinds the check constraint allows', () => {
    expect([...RECONCILE_KINDS]).toEqual([
      'no_purchase',
      'not_paid',
      'amount_mismatch',
      'no_payment',
      'currency_mismatch',
      'plan_mismatch',
      'bad_event',
      'unreadable_purchase',
      'unknown_subscription',
      'cancelled_subscription',
    ]);
  });

  it('answers true for both of them', () => {
    expect(isReconcileKind('unknown_subscription')).toBe(true);
    expect(isReconcileKind('cancelled_subscription')).toBe(true);
  });
});

describe('both kinds reach the screen', () => {
  for (const { kind, name, detail } of NEW_KINDS) {
    it(`draws the English words for ${kind}`, async () => {
      render(<AdminAlertsList client={fakeClient([row({ kind })])} mode="en" />);

      expect(await screen.findByText(t(name, 'en'))).toBeInTheDocument();
      expect(screen.getByText(t(detail, 'en'))).toBeInTheDocument();
      // Not the generic row: this build has its own words for the kind.
      expect(screen.queryByText(t('alerts.kindUnknown', 'en'))).toBeNull();
    });

    it(`draws the Hindi words for ${kind}`, async () => {
      render(<AdminAlertsList client={fakeClient([row({ kind })])} mode="hi" />);

      expect(await screen.findByText(t(name, 'hi'))).toBeInTheDocument();
      expect(screen.getByText(t(detail, 'hi'))).toBeInTheDocument();
      expect(screen.queryByText(t('alerts.kindUnknown', 'hi'))).toBeNull();
    });

    it(`has different words in the two languages for ${kind}`, () => {
      expect(t(name, 'hi')).not.toBe(t(name, 'en'));
      expect(t(detail, 'hi')).not.toBe(t(detail, 'en'));
    });
  }
});

describe('the badge on the Admin home', () => {
  it('counts the two charge kinds too', async () => {
    const rows = NEW_KINDS.map(({ kind }, index) => row({ id: uuid(index + 1), kind }));
    render(<AdminOpenAlertsCount client={fakeClient(rows)} mode="en" />);

    expect(await screen.findByText('2')).toBeInTheDocument();
  });
});
