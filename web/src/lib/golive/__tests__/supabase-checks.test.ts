/**
 * The three Supabase checks, over a FAKE reader and a FAKE fetch
 * (issue 44-h5-golive-readiness).
 *
 * No key and no network: the reader is an interface, so the rules are tested
 * against rows and the REST shape is tested against a stubbed `fetch`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkMigration,
  checkOpenAlerts,
  checkServiceKey,
  latestMigration,
} from '../supabase-checks';
import { createSupabaseGoliveReader, readGoliveServiceEnv } from '../supabase-reader';
import { fakeGoliveReader } from '../fake-reader';

describe('latestMigration', () => {
  it('takes the highest numeric prefix, whatever order the names arrive in', () => {
    const found = latestMigration(['0002_profiles.sql', '0040_ai.sql', '0034_webhook.sql', 'README.md']);
    expect(found).toEqual({ file: '0040_ai.sql', version: '0040' });
  });

  it('is null with no migrations', () => {
    expect(latestMigration([])).toBeNull();
    expect(latestMigration(['notes.txt'])).toBeNull();
  });
});

describe('checkServiceKey', () => {
  it('passes when the one read works', async () => {
    const reader = fakeGoliveReader({ ping: { ok: true, status: 200 } });
    expect((await checkServiceKey(reader)).status).toBe('PASS');
  });

  it('fails on 401 and never prints the key', async () => {
    const reader = fakeGoliveReader({ ping: { ok: false, status: 401 } });
    const check = await checkServiceKey(reader);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('401');
    expect(check.fix).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('fails when it is not configured at all', async () => {
    const reader = fakeGoliveReader({ configured: false });
    const check = await checkServiceKey(reader);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });
});

describe('checkOpenAlerts', () => {
  it('passes on zero open rows', async () => {
    const check = await checkOpenAlerts(fakeGoliveReader({ openAlerts: [] }));
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('0');
  });

  it('fails and lists the open rows BY KIND', async () => {
    const check = await checkOpenAlerts(
      fakeGoliveReader({
        openAlerts: [
          { id: 'a', kind: 'no_payment', subject: 's1', orderId: null, createdAt: null },
          { id: 'b', kind: 'no_payment', subject: 's2', orderId: null, createdAt: null },
          { id: 'c', kind: 'amount_mismatch', subject: 's3', orderId: null, createdAt: null },
        ],
      }),
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('no_payment 2');
    expect(check.detail).toContain('amount_mismatch 1');
  });

  it('warns when the read itself broke', async () => {
    const check = await checkOpenAlerts(fakeGoliveReader({ throwOn: 'openAlerts' }));
    expect(check.status).toBe('WARN');
  });
});

describe('checkMigration', () => {
  it('passes when the latest file is in schema_migrations', async () => {
    const check = await checkMigration(fakeGoliveReader({ migration: 'yes' }), {
      file: '0040_ai.sql',
      version: '0040',
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('0040');
  });

  it('fails when the latest file is NOT applied', async () => {
    const check = await checkMigration(fakeGoliveReader({ migration: 'no' }), {
      file: '0040_ai.sql',
      version: '0040',
    });
    expect(check.status).toBe('FAIL');
    expect(check.fix).toContain('db push');
  });

  it('is MANUAL with the SQL line when the table is not readable', async () => {
    const check = await checkMigration(fakeGoliveReader({ migration: 'unreadable' }), {
      file: '0040_ai.sql',
      version: '0040',
    });
    expect(check.status).toBe('MANUAL');
    expect(check.fix).toContain('select version from supabase_migrations.schema_migrations');
  });

  it('is MANUAL when there are no migration files to compare', async () => {
    const check = await checkMigration(fakeGoliveReader({ migration: 'yes' }), null);
    expect(check.status).toBe('MANUAL');
  });
});

describe('readGoliveServiceEnv', () => {
  it('needs both names and trims the trailing slash', () => {
    expect(readGoliveServiceEnv({})).toBeNull();
    expect(readGoliveServiceEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co' })).toBeNull();
    expect(
      readGoliveServiceEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co/',
        SUPABASE_SERVICE_ROLE_KEY: 'srv',
      }),
    ).toEqual({ url: 'https://p.supabase.co', serviceRoleKey: 'srv' });
  });
});

describe('createSupabaseGoliveReader', () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

  it('reads open alerts through PostgREST', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: 'a', kind: 'no_payment', subject: 'pay_1', order_id: 'order_1', created_at: '2026-11-01T00:00:00Z' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const rows = await createSupabaseGoliveReader({ env, fetchImpl }).openAlerts();
    expect(rows).toEqual([
      { id: 'a', kind: 'no_payment', subject: 'pay_1', orderId: 'order_1', createdAt: '2026-11-01T00:00:00Z' },
    ]);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/rest/v1/reconcile_alerts');
    expect(String(url)).toContain('resolved_at=is.null');
  });

  it('answers "unreadable" when the migrations schema is not exposed', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 406 })) as unknown as typeof fetch;
    expect(await createSupabaseGoliveReader({ env, fetchImpl }).migrationApplied('0040')).toBe('unreadable');
  });

  it('answers yes and no from the migrations table when it IS exposed', async () => {
    const yes = vi.fn(async () => new Response(JSON.stringify([{ version: '0040' }]), { status: 200 })) as unknown as typeof fetch;
    expect(await createSupabaseGoliveReader({ env, fetchImpl: yes }).migrationApplied('0040')).toBe('yes');

    const no = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    expect(await createSupabaseGoliveReader({ env, fetchImpl: no }).migrationApplied('0040')).toBe('no');
  });

  it('never puts the service key in a thrown message', async () => {
    const fetchImpl = vi.fn(async () => new Response('token srv leaked', { status: 500 })) as unknown as typeof fetch;
    await expect(createSupabaseGoliveReader({ env, fetchImpl }).openAlerts()).rejects.toThrow(/status 500/);
    await expect(createSupabaseGoliveReader({ env, fetchImpl }).openAlerts()).rejects.not.toThrow(/srv/);
  });
});
