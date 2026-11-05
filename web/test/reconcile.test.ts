/**
 * The reconcile alert table and the monthly payout
 * (issue 29-ledger-reconcile-payouts).
 *
 * Two jobs live in `0029_reconcile.sql`, and both of them are about running
 * twice safely:
 *
 *  * A6, the nightly reconcile. `record_reconcile_alert()` writes a mismatch
 *    ONCE, however many nights it keeps seeing it. `(kind, subject)` is UNIQUE
 *    and the insert is `on conflict do nothing`, so the de-dupe and the write
 *    are one statement and two runs cannot race each other.
 *
 *  * X1, the monthly manual bank transfer. `mark_payout_paid()` writes the
 *    `payouts` row AND links every unpaid ledger row of that month to it in
 *    ONE transaction. A second press finds nothing unpaid and pays nothing, so
 *    a double click is not a double payment.
 *
 * The other half is who may do it. A teacher reads their own payouts and never
 * an alert; a student reads neither; only an admin may mark a payout paid. RLS
 * is Postgres, not JavaScript: seed with `db.admin`, assert with `db.asUser`.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher, 50% share. Earns everything in this file. */
let teacher: string;
/** A second teacher, so the report has to group by somebody. */
let other: string;
/** The buyer. */
let student: string;
let adminUser: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

/** 2% of Rs 399. Same test-mode fee the 0027 suite uses. */
const FEE = '7.98';

let setId: string;
let otherSetId: string;

async function insertSet(owner: string, price = 399) {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, $4, 'live')
     returning id`,
    [owner, NET, 'Full length set', price],
  );
  return res.rows[0].id;
}

/**
 * One finished sale: checkout as the student, then the webhook's own
 * `grant_purchase()` as the service role. Leaves one `teacher_ledger` row.
 */
async function sell(forSet: string, orderId: string) {
  const started = await db.asUser(student, async (sql) => {
    const res = await sql.query<{ purchase_id: string; status: string }>(
      'select * from public.start_set_purchase($1, $2)',
      [forSet, null],
    );
    return res.rows[0];
  });
  await db.asUser(student, async (sql) => {
    await sql.query('select public.attach_order_id($1, $2)', [started.purchase_id, orderId]);
  });
  await db.admin.query('select public.grant_purchase($1, $2)', [orderId, FEE]);
  // The student may own each set only once, so the next sale needs a clean
  // slate. The LEDGER row stays: that is the thing under test.
  await db.admin.query('delete from public.set_access where user_id = $1', [student]);
  return started.purchase_id;
}

/** Move a ledger row (and its purchase) into a named month, for the report. */
async function backdate(purchaseId: string, iso: string) {
  await db.admin.query('update public.teacher_ledger set created_at = $2 where purchase_id = $1', [
    purchaseId,
    iso,
  ]);
}

/**
 * PGlite hands `count(*)` and `bigint` back as JS numbers and `numeric` back
 * as a STRING, because a numeric(12,2) does not fit a float without losing
 * paise. The rupee amounts are compared as the strings Postgres sends.
 */
interface ReportRow {
  teacher_id: string;
  period: string;
  sale_count: number;
  amount: string;
}

/**
 * The payout report, read the way the admin screen really reads it: as the
 * ADMIN'S OWN signed-in token, never as the database owner. Both payout
 * functions guard on `is_admin()`, and `db.admin` has no `auth.uid()` at all,
 * so running them with it would pass the test and tell us nothing about the
 * one call the app actually makes.
 */
function report(period: string | null = null, as?: string) {
  return db.asUser(as ?? adminUser, async (handle) => {
    const res = await handle.query<ReportRow>('select * from public.payout_report($1)', [period]);
    return res.rows;
  });
}

function markPaid(
  forTeacher: string,
  period: string,
  reference: string | null = 'UTR123',
  as?: string,
) {
  return db.asUser(as ?? adminUser, async (handle) => {
    const res = await handle.query<{ payout_id: string | null }>(
      'select public.mark_payout_paid($1, $2, $3) as payout_id',
      [forTeacher, period, reference],
    );
    return res.rows[0].payout_id;
  });
}

function alert(
  kind: string,
  subject: string,
  orderId: string | null = null,
  expected: number | null = null,
  actual: number | null = null,
) {
  return db.admin
    .query<{ fresh: boolean }>(
      'select public.record_reconcile_alert($1, $2, $3, $4, $5) as fresh',
      [kind, subject, orderId, expected, actual],
    )
    .then((r) => r.rows[0].fresh);
}

function alertRows() {
  return db.admin
    .query<{
      kind: string;
      subject: string;
      order_id: string | null;
      expected_paise: number | null;
      actual_paise: number | null;
      resolved_at: string | null;
    }>('select * from public.reconcile_alerts order by created_at, subject')
    .then((r) => r.rows);
}

function ledgerPayouts() {
  return db.admin
    .query<{ payout_id: string | null; teacher_amount: string }>(
      'select payout_id, teacher_amount from public.teacher_ledger order by created_at',
    )
    .then((r) => r.rows);
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  other = await db.createUser();
  student = await db.createUser();
  adminUser = await db.createUser();

  // `profiles_block_role_change` refuses a role change by anybody but an
  // admin, so the first admin is seeded as a fresh row, not an update.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminUser]);

  for (const one of [teacher, other]) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status, revenue_share_pct)
       values ($1, 'alias', 'Polity Guru', 'approved', 50)`,
      [one],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.reconcile_alerts');
  await db.admin.query('delete from public.teacher_ledger');
  await db.admin.query('delete from public.payouts');
  await db.admin.query('delete from public.payment_events');
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.mock_sets');
  setId = await insertSet(teacher, 399);
  otherSetId = await insertSet(other, 299);
});

describe('the migration', () => {
  it('is applied in issue-number order', () => {
    expect(db.migrations).toContain('0029_reconcile.sql');
  });

  it('puts RLS on the alert table', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'reconcile_alerts'`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });
});

describe('record_reconcile_alert (A6)', () => {
  it('writes a new mismatch and says it was new', async () => {
    expect(await alert('no_purchase', 'pay_ghost', 'order_ghost', null, 39_900)).toBe(true);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'no_purchase',
      subject: 'pay_ghost',
      order_id: 'order_ghost',
      actual_paise: 39_900,
      expected_paise: null,
      resolved_at: null,
    });
  });

  it('is safe to run twice: the same mismatch stays one row', async () => {
    await alert('no_purchase', 'pay_ghost', 'order_ghost', null, 39_900);
    expect(await alert('no_purchase', 'pay_ghost', 'order_ghost', null, 39_900)).toBe(false);

    expect(await alertRows()).toHaveLength(1);
  });

  it('keeps two different problems with the same payment apart', async () => {
    await alert('no_purchase', 'pay_1');
    await alert('amount_mismatch', 'pay_1', 'order_1', 39_900, 9_900);

    expect(await alertRows()).toHaveLength(2);
  });

  it('refuses a kind it does not know, so a typo cannot hide a mismatch', async () => {
    await expect(alert('whoops', 'pay_1')).rejects.toThrow();
  });

  it('refuses a blank subject: an alert nobody can look up is noise', async () => {
    await expect(alert('no_purchase', '   ')).rejects.toThrow();
  });
});

describe('who may read an alert', () => {
  beforeEach(async () => {
    await alert('no_purchase', 'pay_ghost', 'order_ghost', null, 39_900);
  });

  it('shows it to an admin', async () => {
    const rows = await db.asUser(adminUser, async (sql) => {
      const res = await sql.query('select * from public.reconcile_alerts');
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('hides it from a teacher: the payload names another sale', async () => {
    const rows = await db.asUser(teacher, async (sql) => {
      const res = await sql.query('select * from public.reconcile_alerts');
      return res.rows;
    });
    expect(rows).toEqual([]);
  });

  it('hides it from a student', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query('select * from public.reconcile_alerts');
      return res.rows;
    });
    expect(rows).toEqual([]);
  });

  it('refuses the writer to a signed-in student: a forged alert is noise', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('select public.record_reconcile_alert($1, $2)', ['no_purchase', 'pay_x']);
      }),
    ).rejects.toThrow();
  });
});

describe('payout_report (X1)', () => {
  it('is empty with no sales', async () => {
    expect(await report()).toEqual([]);
  });

  it('sums the unpaid ledger per teacher per month', async () => {
    // Rs 399: GST 60.86, fee 7.98, net 330.16, 50% = 165.08 each.
    const first = await sell(setId, 'order_a');
    const second = await sell(setId, 'order_b');
    await backdate(first, '2026-10-12T06:00:00Z');
    await backdate(second, '2026-10-20T06:00:00Z');

    const rows = await report();
    expect(rows).toEqual([
      { teacher_id: teacher, period: '2026-10', sale_count: 2, amount: '330.16' },
    ]);
  });

  it('keeps two months and two teachers apart', async () => {
    const octoberSale = await sell(setId, 'order_oct');
    await backdate(octoberSale, '2026-10-12T06:00:00Z');
    const novemberSale = await sell(setId, 'order_nov');
    await backdate(novemberSale, '2026-11-02T06:00:00Z');
    const otherSale = await sell(otherSetId, 'order_other');
    await backdate(otherSale, '2026-11-03T06:00:00Z');

    const rows = await report();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.teacher_id === teacher).map((r) => r.period).sort()).toEqual([
      '2026-10',
      '2026-11',
    ]);
    expect(rows.filter((r) => r.teacher_id === other)).toHaveLength(1);
  });

  it('filters to one month when asked', async () => {
    const octoberSale = await sell(setId, 'order_oct');
    await backdate(octoberSale, '2026-10-12T06:00:00Z');
    const novemberSale = await sell(setId, 'order_nov');
    await backdate(novemberSale, '2026-11-02T06:00:00Z');

    const rows = await report('2026-10');
    expect(rows).toHaveLength(1);
    expect(rows[0].period).toBe('2026-10');
  });

  it('uses the Indian month, not UTC: a late-night sale belongs to the next day', async () => {
    // 2026-10-31 20:00 UTC is 2026-11-01 01:30 IST, so it is November money.
    const sale = await sell(setId, 'order_late');
    await backdate(sale, '2026-10-31T20:00:00Z');

    const rows = await report();
    expect(rows[0].period).toBe('2026-11');
  });

  it('leaves a refunded sale out', async () => {
    const kept = await sell(setId, 'order_keep');
    const gone = await sell(setId, 'order_refund');
    await backdate(kept, '2026-10-12T06:00:00Z');
    await backdate(gone, '2026-10-13T06:00:00Z');

    // 0027 keeps the ledger row on a refund on purpose (a ledger is
    // append-only), so the report is the thing that has to exclude it.
    await db.admin.query('select public.refund_purchase($1)', ['order_refund']);

    const rows = await report();
    expect(rows).toEqual([
      { teacher_id: teacher, period: '2026-10', sale_count: 1, amount: '165.08' },
    ]);
  });

  it('refuses a teacher: the report names every teacher on the platform', async () => {
    await expect(report(null, teacher)).rejects.toThrow();
  });

  it('refuses a student', async () => {
    await expect(report(null, student)).rejects.toThrow();
  });
});

describe('mark_payout_paid (X1)', () => {
  it('links the ledger rows and takes them out of the unpaid sum', async () => {
    const first = await sell(setId, 'order_a');
    const second = await sell(setId, 'order_b');
    await backdate(first, '2026-10-12T06:00:00Z');
    await backdate(second, '2026-10-20T06:00:00Z');

    const payoutId = await markPaid(teacher, '2026-10');
    expect(payoutId).toMatch(/^[0-9a-f-]{36}$/);

    // Every ledger row of that month now points at the payout.
    const linked = await ledgerPayouts();
    expect(linked).toHaveLength(2);
    expect(linked.every((row) => row.payout_id === payoutId)).toBe(true);

    // And the unpaid report is empty, which is the whole point.
    expect(await report()).toEqual([]);

    const payouts = await db.admin.query<{
      teacher_id: string;
      period: string;
      amount: string;
      reference: string | null;
      paid_at: string | null;
    }>('select * from public.payouts');
    expect(payouts.rows).toHaveLength(1);
    expect(payouts.rows[0]).toMatchObject({
      teacher_id: teacher,
      period: '2026-10',
      amount: '330.16',
      reference: 'UTR123',
    });
    expect(payouts.rows[0].paid_at).not.toBeNull();
  });

  it('leaves another month alone', async () => {
    const octoberSale = await sell(setId, 'order_oct');
    await backdate(octoberSale, '2026-10-12T06:00:00Z');
    const novemberSale = await sell(setId, 'order_nov');
    await backdate(novemberSale, '2026-11-02T06:00:00Z');

    await markPaid(teacher, '2026-10');

    const rows = await report();
    expect(rows).toEqual([
      { teacher_id: teacher, period: '2026-11', sale_count: 1, amount: '165.08' },
    ]);
  });

  it('leaves another teacher alone', async () => {
    const mine = await sell(setId, 'order_mine');
    await backdate(mine, '2026-10-12T06:00:00Z');
    const theirs = await sell(otherSetId, 'order_theirs');
    await backdate(theirs, '2026-10-13T06:00:00Z');

    await markPaid(teacher, '2026-10');

    const rows = await report();
    expect(rows).toHaveLength(1);
    expect(rows[0].teacher_id).toBe(other);
  });

  it('pays nothing the second time: a double click is not a double payment', async () => {
    const sale = await sell(setId, 'order_a');
    await backdate(sale, '2026-10-12T06:00:00Z');

    const firstId = await markPaid(teacher, '2026-10');
    const secondId = await markPaid(teacher, '2026-10');

    expect(firstId).not.toBeNull();
    // NULL means "nothing was owed", so the UI can say so instead of
    // reporting a payout that did not happen.
    expect(secondId).toBeNull();

    const payouts = await db.admin.query<{ amount: string }>('select amount from public.payouts');
    expect(payouts.rows).toEqual([{ amount: '165.08' }]);
  });

  it('answers NULL when a month has no unpaid sales at all', async () => {
    expect(await markPaid(teacher, '2026-09')).toBeNull();
    const payouts = await db.admin.query('select * from public.payouts');
    expect(payouts.rows).toEqual([]);
  });

  it('adds a late sale to the month it already paid, rather than stranding it', async () => {
    const early = await sell(setId, 'order_a');
    await backdate(early, '2026-10-12T06:00:00Z');
    const payoutId = await markPaid(teacher, '2026-10');

    // A webhook that arrived days later, back-dated into the paid month.
    const late = await sell(setId, 'order_late');
    await backdate(late, '2026-10-28T06:00:00Z');

    const again = await markPaid(teacher, '2026-10', 'UTR456');
    expect(again).toBe(payoutId);

    const payouts = await db.admin.query<{ amount: string; reference: string | null }>(
      'select amount, reference from public.payouts',
    );
    expect(payouts.rows).toEqual([{ amount: '330.16', reference: 'UTR456' }]);
    expect((await ledgerPayouts()).every((row) => row.payout_id === payoutId)).toBe(true);
  });

  it('never pays out a refunded sale', async () => {
    const kept = await sell(setId, 'order_keep');
    const gone = await sell(setId, 'order_refund');
    await backdate(kept, '2026-10-12T06:00:00Z');
    await backdate(gone, '2026-10-13T06:00:00Z');
    await db.admin.query('select public.refund_purchase($1)', ['order_refund']);

    const payoutId = await markPaid(teacher, '2026-10');

    const rows = await ledgerPayouts();
    // One linked, one left alone: a refunded sale is never somebody's money.
    expect(rows.filter((r) => r.payout_id === payoutId)).toHaveLength(1);
    expect(rows.filter((r) => r.payout_id === null)).toHaveLength(1);

    const payouts = await db.admin.query<{ amount: string }>('select amount from public.payouts');
    expect(payouts.rows).toEqual([{ amount: '165.08' }]);
  });

  it('refuses a month it cannot read', async () => {
    await expect(markPaid(teacher, 'last month')).rejects.toThrow();
  });

  it('refuses a teacher paying themselves', async () => {
    const sale = await sell(setId, 'order_a');
    await backdate(sale, '2026-10-12T06:00:00Z');

    await expect(markPaid(teacher, '2026-10', 'UTR123', teacher)).rejects.toThrow();
    expect((await ledgerPayouts())[0].payout_id).toBeNull();
  });

  it('refuses a student', async () => {
    await expect(markPaid(teacher, '2026-10', 'UTR123', student)).rejects.toThrow();
  });

  it('refuses a visitor who is not signed in', async () => {
    await expect(
      db.asAnon(async (sql) => {
        await sql.query('select public.mark_payout_paid($1, $2, $3)', [teacher, '2026-10', null]);
      }),
    ).rejects.toThrow();
  });
});

describe('what the teacher sees', () => {
  it('reads their own payout, so the dashboard can show it', async () => {
    const sale = await sell(setId, 'order_a');
    await backdate(sale, '2026-10-12T06:00:00Z');
    await markPaid(teacher, '2026-10');

    const rows = await db.asUser(teacher, async (sql) => {
      const res = await sql.query<{ amount: string }>('select amount from public.payouts');
      return res.rows;
    });
    expect(rows).toEqual([{ amount: '165.08' }]);
  });

  it('never reads another teacher payout', async () => {
    const sale = await sell(setId, 'order_a');
    await backdate(sale, '2026-10-12T06:00:00Z');
    await markPaid(teacher, '2026-10');

    const rows = await db.asUser(other, async (sql) => {
      const res = await sql.query('select * from public.payouts');
      return res.rows;
    });
    expect(rows).toEqual([]);
  });
});

describe('the PM2 app (D1, D2, D5)', () => {
  /** PM2 reads this file with `require`, so the test reads it the same way. */
  const apps = createRequire(import.meta.url)('../ecosystem.config.cjs').apps as {
    name: string;
    script: string;
    cron_restart?: string | null;
    autorestart?: boolean;
    stop_exit_codes?: number[];
    env?: Record<string, string>;
  }[];
  const ledger = apps.find((app) => app.name === 'polity-ledger');

  it('exists and runs the reconcile job', () => {
    expect(ledger).toBeTruthy();
    expect(ledger?.script).toBe('jobs/ledger-reconcile.ts');
  });

  it('is on a 2 AM cron (design.md D5)', () => {
    expect(ledger?.cron_restart).toBe('0 2 * * *');
  });

  it('blanks CLAUDECODE, so the job is the same job whoever started it (D2)', () => {
    expect(ledger?.env?.CLAUDECODE).toBe('');
  });

  it('treats a clean exit as DONE and does not restart it', () => {
    // Without both of these a finished night shows as `errored` in `pm2 list`
    // and PM2 starts it again a second later.
    expect(ledger?.stop_exit_codes).toEqual([0]);
    expect(ledger?.autorestart).toBe(false);
  });

  it('leaves the PDF split worker alone', () => {
    const split = apps.find((app) => app.name === 'polity-pdf-split');
    expect(split?.cron_restart ?? null).toBeNull();
    expect(split?.autorestart).toBe(true);
  });
});
