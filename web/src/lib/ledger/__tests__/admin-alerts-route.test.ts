/**
 * /api/admin/alerts, the decision logic (issue 35-reconcile-visible).
 *
 * Nothing outside the nightly job could read `reconcile_alerts`, so a found
 * money problem sat in a table nobody opened. This route is how it reaches a
 * human.
 *
 * Order of checks: session, then role, then config, then the body. A teacher
 * gets the same 403 whether or not Supabase is set up, so this route cannot be
 * used to probe the deployment. Same shape as `admin-payouts-route`.
 *
 * The real gate is RLS: `reconcile_alerts_admin_all` in 0029 hands a student
 * and a teacher zero rows and refuses their update. This route is defence in
 * depth, and it is why the 403 tests below matter even though Postgres would
 * refuse too.
 */
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleAdminAlerts } from '../admin-alerts-route';
import { createFakeAlertsClient, type ReconcileAlertRow } from '../types';

const ALERT_ID = '22222222-2222-4222-8222-222222222222';

function session(role: AuthSession['role']): AuthSession {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    userId: '33333333-3333-4333-8333-333333333333',
    role,
  };
}

function alertRow(values: Partial<ReconcileAlertRow> = {}): ReconcileAlertRow {
  return {
    id: ALERT_ID,
    kind: 'no_purchase',
    subject: 'pay_ghost',
    orderId: 'order_ghost',
    expectedPaise: null,
    actualPaise: 39_900,
    createdAtIso: '2026-11-05T02:00:00.000Z',
    ...values,
  };
}

function run(options: {
  method?: 'GET' | 'POST';
  body?: unknown;
  who?: AuthSession | null;
  alerts?: readonly ReconcileAlertRow[];
  configured?: boolean;
  fail?: boolean;
}) {
  const client = createFakeAlertsClient({
    configured: options.configured ?? true,
    alerts: options.alerts ?? [],
    fail: options.fail ?? false,
  });
  return handleAdminAlerts({
    method: options.method ?? 'GET',
    body: options.body ?? null,
    session: options.who === undefined ? session('admin') : options.who,
    client,
  }).then((reply) => ({ ...reply, client }));
}

describe('who may use it', () => {
  it('refuses nobody signed in with 401', async () => {
    const reply = await run({ who: null });
    expect(reply.status).toBe(401);
  });

  it('refuses a student with 403', async () => {
    const reply = await run({ who: session('student') });
    expect(reply.status).toBe(403);
  });

  it('refuses a teacher with 403: a subject names another sale', async () => {
    const reply = await run({ who: session('teacher') });
    expect(reply.status).toBe(403);
  });

  it('refuses a teacher the same way whether Supabase is set up or not', async () => {
    const off = await run({ who: session('teacher'), configured: false });
    const on = await run({ who: session('teacher'), configured: true });
    expect(off).toMatchObject({ status: 403 });
    expect(on.status).toBe(403);
  });

  it('answers 503 to an admin when Supabase is not set up', async () => {
    const reply = await run({ configured: false });
    expect(reply.status).toBe(503);
  });

  it('reads nothing at all when it refuses', async () => {
    const reply = await run({ who: session('student'), alerts: [alertRow()] });
    expect(reply.client.listCalls).toBe(0);
  });
});

describe('GET: the open list', () => {
  it('hands an admin the open alerts', async () => {
    const reply = await run({ alerts: [alertRow()] });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ alerts: [alertRow()] });
    expect(reply.client.listCalls).toBe(1);
  });

  it('answers 502 and a fixed message when the read failed', async () => {
    const reply = await run({ fail: true });

    expect(reply.status).toBe(502);
    // Fixed message only: a Postgres error quotes policy and constraint names.
    expect(reply.body).toEqual({ error: 'read failed' });
  });
});

describe('POST: resolve one alert', () => {
  it('resolves it and says so', async () => {
    const reply = await run({ method: 'POST', body: { id: ALERT_ID }, alerts: [alertRow()] });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ resolved: true });
    expect(reply.client.resolved).toEqual([ALERT_ID]);
  });

  it('refuses a body that is not an object', async () => {
    const reply = await run({ method: 'POST', body: 'hello' });
    expect(reply.status).toBe(400);
  });

  it('refuses an id that is not a uuid, before any round trip', async () => {
    const reply = await run({ method: 'POST', body: { id: 'pay_ghost' } });

    expect(reply.status).toBe(400);
    expect(reply.client.resolved).toEqual([]);
  });

  it('says resolved false when the row was already resolved', async () => {
    // An empty alert list means the id matched nothing still open, which is a
    // real answer and not an error: somebody else got there first.
    const reply = await run({ method: 'POST', body: { id: ALERT_ID }, alerts: [] });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ resolved: false });
  });

  it('answers 502 when the write failed', async () => {
    const reply = await run({ method: 'POST', body: { id: ALERT_ID }, fail: true });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});
