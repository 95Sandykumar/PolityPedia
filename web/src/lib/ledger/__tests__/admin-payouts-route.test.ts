/**
 * The decision logic behind /api/admin/payouts
 * (issue 29-ledger-reconcile-payouts).
 *
 * This route moves money, so the order of the checks is the test: session,
 * then role, then config, then the body. A teacher must get the same 403
 * whether or not Supabase is set up, so the route cannot be used to probe the
 * deployment, and a bad month must never reach Postgres.
 *
 * The client is faked, so there is no network call and no key (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleAdminPayouts } from '../admin-payouts-route';
import type { MarkPaidInput, PayoutLine, PayoutsClient } from '../types';

const TEACHER = '3f2cfcdb-ed8e-4612-957d-aad14453f863';
const PAYOUT = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

function session(role: AuthSession['role']): AuthSession {
  return { accessToken: 'token', refreshToken: 'refresh', userId: TEACHER, role };
}

const LINE: PayoutLine = { teacherId: TEACHER, period: '2026-10', saleCount: 2, amountInr: 330.16 };

interface FakeClient {
  client: PayoutsClient;
  marked: MarkPaidInput[];
  reported: (string | null | undefined)[];
}

function fakeClient(
  options: { configured?: boolean; payoutId?: string | null; throws?: boolean } = {},
): FakeClient {
  const marked: MarkPaidInput[] = [];
  const reported: (string | null | undefined)[] = [];
  const client: PayoutsClient = {
    isConfigured() {
      return options.configured ?? true;
    },
    async report(period) {
      reported.push(period);
      if (options.throws) throw new Error('relation "x" does not exist');
      return [LINE];
    },
    async markPaid(input) {
      marked.push(input);
      if (options.throws) throw new Error('policy "payouts_admin_all" refused');
      return { payoutId: options.payoutId === undefined ? PAYOUT : options.payoutId };
    },
  };
  return { client, marked, reported };
}

describe('reading the report', () => {
  it('answers an admin with the lines', async () => {
    const { client, reported } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      session: session('admin'),
      client,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ lines: [LINE] });
    expect(reported).toEqual([null]);
  });

  it('passes a month filter through', async () => {
    const { client, reported } = fakeClient();

    await handleAdminPayouts({
      method: 'GET',
      body: null,
      period: '2026-10',
      session: session('admin'),
      client,
    });

    expect(reported).toEqual(['2026-10']);
  });

  it('drops a month it cannot read rather than guessing one', async () => {
    const { client, reported } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      period: 'last month',
      session: session('admin'),
      client,
    });

    expect(reply.status).toBe(200);
    expect(reported).toEqual([null]);
  });
});

describe('marking a payout paid', () => {
  it('passes the teacher, the month and the reference through', async () => {
    const { client, marked } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-10', reference: ' UTR123 ' },
      session: session('admin'),
      client,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ payoutId: PAYOUT });
    expect(marked).toEqual([{ teacherId: TEACHER, period: '2026-10', reference: 'UTR123' }]);
  });

  it('reports "nothing owed" as a 200 with a null id, not as a failure', async () => {
    const { client } = fakeClient({ payoutId: null });

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-10' },
      session: session('admin'),
      client,
    });

    expect(reply).toEqual({ status: 200, body: { payoutId: null } });
  });

  it('refuses a month it cannot read, without calling Postgres', async () => {
    const { client, marked } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-13' },
      session: session('admin'),
      client,
    });

    expect(reply).toEqual({ status: 400, body: { error: 'bad request' } });
    expect(marked).toEqual([]);
  });

  it('refuses a teacher id that is not a uuid', async () => {
    const { client, marked } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: 'me', period: '2026-10' },
      session: session('admin'),
      client,
    });

    expect(reply.status).toBe(400);
    expect(marked).toEqual([]);
  });

  it('refuses a body that is not an object', async () => {
    const { client } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: null,
      session: session('admin'),
      client,
    });

    expect(reply.status).toBe(400);
  });
});

describe('who may call it', () => {
  it('asks a visitor to sign in', async () => {
    const { client, marked } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-10' },
      session: null,
      client,
    });

    expect(reply).toEqual({ status: 401, body: { error: 'sign in' } });
    expect(marked).toEqual([]);
  });

  it('refuses a teacher paying themselves', async () => {
    const { client, marked } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-10' },
      session: session('teacher'),
      client,
    });

    expect(reply).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(marked).toEqual([]);
  });

  it('refuses a student', async () => {
    const { client } = fakeClient();

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      session: session('student'),
      client,
    });

    expect(reply.status).toBe(403);
  });

  it('gives a teacher the same 403 when Supabase is NOT set up, so the route cannot be probed', async () => {
    const { client } = fakeClient({ configured: false });

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      session: session('teacher'),
      client,
    });

    expect(reply).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it('tells an admin when Supabase is not set up', async () => {
    const { client } = fakeClient({ configured: false });

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      session: session('admin'),
      client,
    });

    expect(reply).toEqual({ status: 503, body: { error: 'not configured' } });
  });
});

describe('a failure from Postgres', () => {
  it('becomes a fixed message, so no policy name reaches the browser', async () => {
    const { client } = fakeClient({ throws: true });

    const reply = await handleAdminPayouts({
      method: 'POST',
      body: { teacherId: TEACHER, period: '2026-10' },
      session: session('admin'),
      client,
    });

    expect(reply).toEqual({ status: 502, body: { error: 'save failed' } });
  });

  it('does the same on a read', async () => {
    const { client } = fakeClient({ throws: true });

    const reply = await handleAdminPayouts({
      method: 'GET',
      body: null,
      session: session('admin'),
      client,
    });

    expect(reply).toEqual({ status: 502, body: { error: 'read failed' } });
  });
});
