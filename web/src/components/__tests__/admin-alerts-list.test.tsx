/**
 * Admin > Money alerts (issue 35-reconcile-visible).
 *
 * The nightly job has been writing `reconcile_alerts` rows since issue 29 and
 * NOTHING read them: no page, no message. A money problem found at 2 AM waited
 * for somebody to open a database console. This screen is the human end of it.
 *
 * Three things it has to get right:
 *
 *  1. Every label exists in English AND Hindi (web/CLAUDE.md). Mode `both`
 *     shows the English line with the Hindi line under it.
 *  2. A failed read must NOT look like an empty list. "No open alerts" and
 *     "could not load" are opposite answers, and one of them is money.
 *  3. Resolved presses the store ONCE and then RE-READS, so the row leaves the
 *     list because the database says so and not because the button was tapped.
 *
 * The client is faked, so there is no network call and no key.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminAlertsList } from '../admin-alerts-list';
import { AdminOpenAlertsCount } from '../admin-open-alerts-count';
import { t } from '@/lib/i18n';
import type { BrowserAlertsClient, ReconcileAlertRow } from '@/lib/ledger/types';

const ALERT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

function alertRow(values: Partial<ReconcileAlertRow> = {}): ReconcileAlertRow {
  return {
    id: ALERT_ID,
    kind: 'no_purchase',
    subject: 'pay_Ghost123',
    orderId: 'order_Ghost123',
    expectedPaise: null,
    actualPaise: 39_900,
    createdAtIso: '2026-11-05T02:00:00.000Z',
    ...values,
  };
}

interface Fake {
  client: BrowserAlertsClient;
  resolved: string[];
  reads: number;
}

function fake(
  options: {
    alerts?: readonly ReconcileAlertRow[];
    after?: readonly ReconcileAlertRow[];
    listThrows?: boolean;
    resolveThrows?: boolean;
  } = {},
): Fake {
  const state: Fake = {
    resolved: [],
    reads: 0,
    client: {
      async list() {
        state.reads += 1;
        if (options.listThrows) throw new Error('500');
        if (state.reads > 1 && options.after) return [...options.after];
        return [...(options.alerts ?? [alertRow()])];
      },
      async resolve(id: string) {
        state.resolved.push(id);
        if (options.resolveThrows) throw new Error('policy refused');
        return true;
      },
    },
  };
  return state;
}

describe('the open list', () => {
  it('shows when, the kind, the payment id and the amount', async () => {
    render(<AdminAlertsList client={fake().client} />);

    // The payment id is what a human looks the problem up by.
    expect(await screen.findByText('pay_Ghost123')).toBeTruthy();
    expect(screen.getByText(t('alerts.kindNoPurchase', 'en'))).toBeTruthy();
    // Paise shown as rupees, to the paisa: 39,900 paise is Rs 399.00.
    expect(screen.getByText('Rs 399.00')).toBeTruthy();
    // The date, as a plain day a human can match to a bank statement.
    expect(screen.getByText(/2026-11-05/)).toBeTruthy();
  });

  it('explains what each kind means, so the page is actionable', async () => {
    render(<AdminAlertsList client={fake().client} />);

    expect(await screen.findByText(t('alerts.detailNoPurchase', 'en'))).toBeTruthy();
  });

  it('says so when nothing is open', async () => {
    render(<AdminAlertsList client={fake({ alerts: [] }).client} />);

    expect(await screen.findByText(t('alerts.empty', 'en'))).toBeTruthy();
  });

  it('does NOT read an empty list as a failed read', async () => {
    render(<AdminAlertsList client={fake({ listThrows: true }).client} />);

    expect(await screen.findByText(t('alerts.readFailed', 'en'))).toBeTruthy();
    expect(screen.queryByText(t('alerts.empty', 'en'))).toBeNull();
  });

  it('says so when Supabase is not set up, and reads nothing', async () => {
    const state = fake();
    render(<AdminAlertsList client={state.client} configured={false} />);

    expect(await screen.findByText(t('alerts.notConfigured', 'en'))).toBeTruthy();
    expect(state.reads).toBe(0);
  });
});

describe('both languages (web/CLAUDE.md)', () => {
  it('shows the English title and the Hindi title under it', async () => {
    render(<AdminAlertsList client={fake().client} mode="both" />);

    expect(await screen.findByText(t('alerts.title', 'en'))).toBeTruthy();
    expect(screen.getByText(t('alerts.title', 'hi'))).toBeTruthy();
  });

  it('shows the Hindi kind label in Hindi mode', async () => {
    render(<AdminAlertsList client={fake().client} mode="hi" />);

    expect(await screen.findByText(t('alerts.kindNoPurchase', 'hi'))).toBeTruthy();
    expect(screen.queryByText(t('alerts.kindNoPurchase', 'en'))).toBeNull();
  });
});

describe('resolving one', () => {
  it('calls the store ONCE with that alert id', async () => {
    const state = fake({ alerts: [alertRow(), alertRow({ id: OTHER_ID, subject: 'pay_Two' })] });
    render(<AdminAlertsList client={state.client} />);

    const buttons = await screen.findAllByRole('button', { name: t('alerts.resolve', 'en') });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(state.resolved).toEqual([ALERT_ID]));
  });

  it('re-reads the list from the database afterwards', async () => {
    const state = fake({ alerts: [alertRow()], after: [] });
    render(<AdminAlertsList client={state.client} />);

    fireEvent.click(await screen.findByRole('button', { name: t('alerts.resolve', 'en') }));

    expect(await screen.findByText(t('alerts.empty', 'en'))).toBeTruthy();
    expect(state.reads).toBe(2);
  });

  it('shows a fixed failure message and keeps the row', async () => {
    const state = fake({ resolveThrows: true });
    render(<AdminAlertsList client={state.client} />);

    fireEvent.click(await screen.findByRole('button', { name: t('alerts.resolve', 'en') }));

    expect(await screen.findByText(t('alerts.failed', 'en'))).toBeTruthy();
    expect(screen.getByText('pay_Ghost123')).toBeTruthy();
  });
});

describe('the count on the admin home', () => {
  it('shows how many alerts are open', async () => {
    const state = fake({ alerts: [alertRow(), alertRow({ id: OTHER_ID })] });
    render(<AdminOpenAlertsCount client={state.client} />);

    expect(await screen.findByText('2')).toBeTruthy();
  });

  it('shows nothing at all when none are open: no badge is the good news', async () => {
    const { container } = render(<AdminOpenAlertsCount client={fake({ alerts: [] }).client} />);

    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('shows nothing when the read failed, rather than a wrong zero', async () => {
    const { container } = render(
      <AdminOpenAlertsCount client={fake({ listThrows: true }).client} />,
    );

    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
