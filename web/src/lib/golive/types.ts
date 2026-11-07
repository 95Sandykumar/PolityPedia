/**
 * The shape of one go-live check (issue 44-h5-golive-readiness).
 *
 * Human ticket H5 is the one ticket where a wrong answer costs real money, so
 * the vocabulary is deliberately small and the meanings do not overlap:
 *
 *   PASS    checked by this program, and it is right.
 *   FAIL    checked by this program, and it is WRONG. Exit code 1.
 *   WARN    checked, and it is not wrong, but it is not go-live either. Test
 *           keys are the main one: nothing is broken, no money moves.
 *   MANUAL  this program cannot check it. A CA's answer, a KYC approval, a
 *           `pm2 jlist` on a laptop that is not this one. NOT a FAIL, because
 *           "I could not look" and "it is broken" are different sentences,
 *           and a tool that mixes them gets ignored.
 *
 * WHY ONLY `FAIL` EXITS NON-ZERO. The preflight is read every day between now
 * and go-live, and today every manual gate is open. If MANUAL exited 1 the
 * number would always be 1, and an exit code that is always 1 tells nobody
 * anything. `--expect live` is the switch that turns the open gates into
 * FAILs, which is exactly the day Boss wants them to be loud.
 */

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'MANUAL';

/** What Boss is asking for today: still on test keys, or going live. */
export type ExpectMode = 'test' | 'live';

export interface Check {
  /** Short, stable, and safe to read out loud. Never holds a value. */
  readonly name: string;
  readonly status: CheckStatus;
  /** The numbers and names behind the status. NEVER a key or a secret. */
  readonly detail: string;
  /** One line Boss can act on. Only present when the status is not PASS. */
  readonly fix?: string;
}

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;

/** The order statuses are printed in a summary: worst first. */
export const STATUS_ORDER: readonly CheckStatus[] = ['FAIL', 'WARN', 'MANUAL', 'PASS'];

/** How many of each status, for the one-line summary. */
export function countByStatus(checks: readonly Check[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, MANUAL: 0 };
  for (const check of checks) out[check.status] += 1;
  return out;
}

/**
 * 1 if anything FAILed, else 0.
 *
 * An empty list is also 1: a preflight that checked nothing has not cleared
 * anything, and answering 0 there is the silent all-clear this whole file
 * exists to prevent.
 */
export function exitCodeFor(checks: readonly Check[]): number {
  if (checks.length === 0) return EXIT_FAIL;
  return checks.some((check) => check.status === 'FAIL') ? EXIT_FAIL : EXIT_OK;
}

/**
 * True when every check is a PASS.
 *
 * This is the bar for "every other money check passes", which is what turns a
 * live Razorpay key from a FAIL into a PASS. A WARN or a MANUAL is not clear:
 * on go-live day there is nothing left to be unsure about.
 */
export function allClear(checks: readonly Check[]): boolean {
  return checks.length > 0 && checks.every((check) => check.status === 'PASS');
}
