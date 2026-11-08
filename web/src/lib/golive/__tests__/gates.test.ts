/**
 * The seven manual gates of H5, read from `web/golive.json`
 * (issue 44-h5-golive-readiness).
 *
 * These are the gates no program can clear: a CA's answer on GST, a contract
 * read, a KYC approval. The file is Boss's signature on each one, and the only
 * job of this code is to refuse to go live while one is unsigned.
 */
import { describe, expect, it } from 'vitest';
import { GOLIVE_GATES, checkGates, parseGoliveFile } from '../gates';

const ALL_DONE = JSON.stringify({
  gates: Object.fromEntries(
    GOLIVE_GATES.map((gate) => [gate.id, { done: true, by: 'Boss', date: '2026-11-20' }]),
  ),
});

describe('GOLIVE_GATES', () => {
  it('is exactly H5: X1, X3, X4, X8, B9, AS6 and Razorpay KYC', () => {
    expect(GOLIVE_GATES.map((gate) => gate.id)).toEqual(['X1', 'X3', 'X4', 'X8', 'B9', 'AS6', 'KYC']);
  });

  it('says who clears each gate and what for', () => {
    for (const gate of GOLIVE_GATES) {
      expect(gate.who.length).toBeGreaterThan(0);
      expect(gate.what.length).toBeGreaterThan(0);
    }
  });
});

describe('parseGoliveFile', () => {
  it('reads a filled-in file', () => {
    const parsed = parseGoliveFile(ALL_DONE);
    expect(parsed.problems).toEqual([]);
    expect(parsed.gates.X4.done).toBe(true);
    expect(parsed.gates.X4.by).toBe('Boss');
  });

  it('treats a missing file as nothing done', () => {
    const parsed = parseGoliveFile(null);
    expect(parsed.missing).toBe(true);
    expect(parsed.gates.X4.done).toBe(false);
  });

  it('treats broken JSON as nothing done, with a problem named', () => {
    const parsed = parseGoliveFile('{not json');
    expect(parsed.problems.length).toBeGreaterThan(0);
    expect(parsed.gates.KYC.done).toBe(false);
  });

  it('refuses a gate marked done with no name and no date', () => {
    const parsed = parseGoliveFile(JSON.stringify({ gates: { X4: { done: true } } }));
    expect(parsed.gates.X4.done).toBe(false);
    expect(parsed.problems.join(' ')).toContain('X4');
  });
});

describe('checkGates', () => {
  it('is MANUAL for every undone gate while the site is in test mode', () => {
    const checks = checkGates(parseGoliveFile(null), 'test');
    expect(checks).toHaveLength(GOLIVE_GATES.length);
    expect(checks.every((check) => check.status === 'MANUAL')).toBe(true);
  });

  it('is FAIL for every undone gate once live is expected', () => {
    const checks = checkGates(parseGoliveFile(null), 'live');
    expect(checks.every((check) => check.status === 'FAIL')).toBe(true);
  });

  it('is PASS for a signed gate, in both modes', () => {
    for (const mode of ['test', 'live'] as const) {
      const checks = checkGates(parseGoliveFile(ALL_DONE), mode);
      expect(checks.every((check) => check.status === 'PASS')).toBe(true);
      expect(checks[0].detail).toContain('Boss');
    }
  });

  it('fails only the one gate that is still open', () => {
    const raw = JSON.parse(ALL_DONE) as { gates: Record<string, unknown> };
    raw.gates.X4 = { done: false, by: null, date: null };
    const checks = checkGates(parseGoliveFile(JSON.stringify(raw)), 'live');
    const bad = checks.filter((check) => check.status === 'FAIL');
    expect(bad).toHaveLength(1);
    expect(bad[0].name).toContain('X4');
  });
});
