/**
 * The two PM2 apps: the config, and whether they are running
 * (issue 44-h5-golive-readiness).
 *
 * design.md D1/D2: the laptop jobs are PM2 apps and every one of them sets
 * `CLAUDECODE: ''`. A missing blank there is the bug where a job behaves
 * differently depending on who started it, so the check reads the real config
 * object rather than trusting the comment at the top of it.
 *
 * Nothing here spawns a process. `pm2 jlist` is passed in as already-parsed
 * JSON, or as null for "pm2 is not installed", which is MANUAL and not a FAIL:
 * PM2 lives on Boss's laptop and the preflight may well run somewhere else.
 */
import { describe, expect, it } from 'vitest';
import { PM2_APPS, checkPm2Config, checkPm2Online } from '../pm2';

const GOOD_APPS = [
  { name: 'polity-pdf-split', env: { NODE_ENV: 'production', CLAUDECODE: '' } },
  { name: 'polity-ledger', env: { NODE_ENV: 'production', CLAUDECODE: '' } },
];

describe('PM2_APPS', () => {
  it('is the two apps H5 has to start', () => {
    expect([...PM2_APPS]).toEqual(['polity-pdf-split', 'polity-ledger']);
  });
});

describe('checkPm2Config', () => {
  it('passes on both apps with a blank CLAUDECODE', () => {
    const check = checkPm2Config(GOOD_APPS);
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('polity-pdf-split');
  });

  it('fails when an app is missing', () => {
    const check = checkPm2Config([GOOD_APPS[0]]);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('polity-ledger');
  });

  it('fails when CLAUDECODE is not blanked (design D1)', () => {
    const check = checkPm2Config([
      GOOD_APPS[0],
      { name: 'polity-ledger', env: { NODE_ENV: 'production' } },
    ]);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('CLAUDECODE');
  });

  it('fails when CLAUDECODE is set to something that is not blank', () => {
    const check = checkPm2Config([
      GOOD_APPS[0],
      { name: 'polity-ledger', env: { CLAUDECODE: '1' } },
    ]);
    expect(check.status).toBe('FAIL');
  });

  it('fails on a config it cannot read at all', () => {
    expect(checkPm2Config(null).status).toBe('FAIL');
    expect(checkPm2Config('nope').status).toBe('FAIL');
  });
});

describe('checkPm2Online', () => {
  it('is MANUAL when pm2 is not installed or could not be run', () => {
    const check = checkPm2Online(null);
    expect(check.status).toBe('MANUAL');
    expect(check.fix).toContain('pm2 start');
  });

  it('passes when both apps are online', () => {
    const check = checkPm2Online([
      { name: 'polity-pdf-split', pm2_env: { status: 'online' } },
      { name: 'polity-ledger', pm2_env: { status: 'online' } },
    ]);
    expect(check.status).toBe('PASS');
  });

  it('passes when the cron app is stopped, because a finished night is stopped', () => {
    // `stop_exit_codes: [0]` in the ecosystem file makes a clean night show as
    // `stopped`, which is the job working, not the job missing.
    const check = checkPm2Online([
      { name: 'polity-pdf-split', pm2_env: { status: 'online' } },
      { name: 'polity-ledger', pm2_env: { status: 'stopped' } },
    ]);
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('stopped');
  });

  it('fails when the listener is not online', () => {
    const check = checkPm2Online([
      { name: 'polity-pdf-split', pm2_env: { status: 'errored' } },
      { name: 'polity-ledger', pm2_env: { status: 'stopped' } },
    ]);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('polity-pdf-split');
  });

  it('fails when an app has never been started', () => {
    const check = checkPm2Online([{ name: 'polity-pdf-split', pm2_env: { status: 'online' } }]);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('polity-ledger');
  });
});
