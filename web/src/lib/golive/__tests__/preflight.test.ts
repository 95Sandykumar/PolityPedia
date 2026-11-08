/**
 * The whole preflight, wired together with fakes
 * (issue 44-h5-golive-readiness).
 *
 * `jobs/golive-check.ts` is a thin wrapper around `runGoliveCheck`, so this is
 * where the behaviour Boss depends on is proved:
 *
 *  * `--expect test` is the state the app is in TODAY: test keys and unsigned
 *    gates are a WARN and a MANUAL, and the exit code is 0.
 *  * `--expect live` is go-live day: the same two states are a FAIL and the
 *    exit code is 1. That is the whole point of the flag.
 *  * No key, no token and no payment secret ever reaches the output.
 *
 * Nothing here touches the network, the filesystem, pm2 or process.exit.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeGoliveReader } from '../fake-reader';
import { formatCheckTable, parseArgs, runGoliveCheck } from '../preflight';
import { GOLIVE_GATES } from '../gates';

const TEST_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_keyid',
  RAZORPAY_KEY_SECRET: 'testsecretvalue',
  RAZORPAY_WEBHOOK_SECRET: 'webhooksecretvalue',
  RAZORPAY_PLAN_PRO_ID: 'plan_pro',
  RAZORPAY_PLAN_AI_ID: 'plan_ai',
  NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'servicerolekeyvalue',
  NEXT_PUBLIC_SITE_URL: 'https://politypedia.vercel.app',
};

const LIVE_ENV = {
  ...TEST_ENV,
  RAZORPAY_KEY_ID: 'rzp_live_keyid',
  RAZORPAY_KEY_SECRET: 'rzp_live_secretvalue',
};

const GOOD_PM2 = [
  { name: 'polity-pdf-split', env: { CLAUDECODE: '' } },
  { name: 'polity-ledger', env: { CLAUDECODE: '' } },
];

const ALL_GATES_SIGNED = JSON.stringify({
  gates: Object.fromEntries(
    GOLIVE_GATES.map((gate) => [gate.id, { done: true, by: 'Boss', date: '2026-11-20' }]),
  ),
});

function refuse(status = 400): typeof fetch {
  return vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
}

function deps(over: Record<string, unknown> = {}) {
  return {
    argv: [],
    env: TEST_ENV,
    fetchImpl: refuse(),
    reader: fakeGoliveReader({ ping: { ok: true, status: 200 }, openAlerts: [], migration: 'yes' }),
    migrationFiles: ['0002_profiles.sql', '0040_ai.sql'],
    pm2Apps: GOOD_PM2,
    pm2Jlist: [
      { name: 'polity-pdf-split', pm2_env: { status: 'online' } },
      { name: 'polity-ledger', pm2_env: { status: 'stopped' } },
    ],
    goliveJson: ALL_GATES_SIGNED,
    ...over,
  };
}

describe('parseArgs', () => {
  it('reads a flag with a space and a flag with an equals sign', () => {
    expect(parseArgs(['--expect', 'live', '--site=https://x.dev']).flags).toEqual({
      expect: 'live',
      site: 'https://x.dev',
    });
  });

  it('reads a bare flag as true and keeps positional words', () => {
    const parsed = parseArgs(['pay_123', '--refunded', '--amount', '299']);
    expect(parsed.positional).toEqual(['pay_123']);
    expect(parsed.flags.refunded).toBe(true);
    expect(parsed.flags.amount).toBe('299');
  });

  it('never reads the sale id as the value of --refunded', () => {
    const parsed = parseArgs(['--refunded', 'pay_123']);
    expect(parsed.positional).toEqual(['pay_123']);
    expect(parsed.flags.refunded).toBe(true);
  });
});

describe('runGoliveCheck with --expect test (today)', () => {
  it('exits 0, warns about test mode and marks nothing as FAIL', async () => {
    const result = await runGoliveCheck(deps());
    expect(result.expect).toBe('test');
    expect(result.exitCode).toBe(0);
    expect(result.checks.filter((check) => check.status === 'FAIL')).toEqual([]);
    expect(result.checks.find((check) => check.name.includes('MODE'))?.status).toBe('WARN');
  });

  it('leaves unsigned gates as MANUAL and still exits 0', async () => {
    const result = await runGoliveCheck(deps({ goliveJson: null }));
    expect(result.exitCode).toBe(0);
    expect(result.checks.filter((check) => check.status === 'MANUAL').length).toBeGreaterThanOrEqual(
      GOLIVE_GATES.length,
    );
  });

  it('still exits 1 on a real problem, even in test mode', async () => {
    const result = await runGoliveCheck(deps({ fetchImpl: refuse(500) }));
    expect(result.exitCode).toBe(1);
  });
});

describe('runGoliveCheck with --expect live (go-live day)', () => {
  it('fails test keys', async () => {
    const result = await runGoliveCheck(deps({ argv: ['--expect', 'live'] }));
    expect(result.expect).toBe('live');
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.name.includes('MODE'))?.status).toBe('FAIL');
  });

  it('fails an unsigned gate', async () => {
    const result = await runGoliveCheck(
      deps({ argv: ['--expect', 'live'], env: LIVE_ENV, goliveJson: null }),
    );
    expect(result.exitCode).toBe(1);
    const gateFails = result.checks.filter(
      (check) => check.status === 'FAIL' && check.name.startsWith('gate '),
    );
    expect(gateFails).toHaveLength(GOLIVE_GATES.length);
  });

  it('passes with live keys, signed gates and everything else clear', async () => {
    const result = await runGoliveCheck(deps({ argv: ['--expect', 'live'], env: LIVE_ENV }));
    expect(result.checks.filter((check) => check.status === 'FAIL')).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.name.includes('MODE'))?.status).toBe('PASS');
  });

  it('refuses live keys while an open reconcile alert is still on the list', async () => {
    const result = await runGoliveCheck(
      deps({
        argv: ['--expect', 'live'],
        env: LIVE_ENV,
        reader: fakeGoliveReader({
          ping: { ok: true, status: 200 },
          migration: 'yes',
          openAlerts: [{ id: 'a', kind: 'no_payment', subject: 's', orderId: null, createdAt: null }],
        }),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.name.includes('MODE'))?.status).toBe('FAIL');
  });
});

describe('runGoliveCheck, bad input and missing env', () => {
  it('answers one clear line and exit 1 for an unknown --expect', async () => {
    const result = await runGoliveCheck(deps({ argv: ['--expect', 'kind-of'] }));
    expect(result.exitCode).toBe(1);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain('test');
    expect(result.checks[0].detail).toContain('live');
  });

  it('names every missing env, exits 1, and shows no stack trace', async () => {
    const result = await runGoliveCheck(deps({ env: {}, reader: fakeGoliveReader({ configured: false }) }));
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('RAZORPAY_KEY_ID');
    expect(result.text).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.text).not.toContain('    at ');
  });

  it('never prints a key, a secret or a token, in either mode', async () => {
    for (const env of [TEST_ENV, LIVE_ENV]) {
      const result = await runGoliveCheck(deps({ env, argv: ['--expect', 'live'] }));
      for (const secret of [
        env.RAZORPAY_KEY_ID,
        env.RAZORPAY_KEY_SECRET,
        env.RAZORPAY_WEBHOOK_SECRET,
        env.SUPABASE_SERVICE_ROLE_KEY,
      ]) {
        expect(result.text).not.toContain(secret);
      }
    }
  });
});

describe('formatCheckTable', () => {
  it('puts every status in the table and every fix under it', () => {
    const text = formatCheckTable([
      { name: 'one', status: 'PASS', detail: 'fine' },
      { name: 'two', status: 'FAIL', detail: 'broken', fix: 'do the thing' },
      { name: 'three', status: 'WARN', detail: 'hmm' },
      { name: 'four', status: 'MANUAL', detail: 'ask a human' },
    ]);
    expect(text).toContain('PASS');
    expect(text).toContain('FAIL');
    expect(text).toContain('WARN');
    expect(text).toContain('MANUAL');
    expect(text).toContain('do the thing');
    expect(text).toMatch(/1 PASS/);
  });
});
