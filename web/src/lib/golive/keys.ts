/**
 * Razorpay env presence and KEY MODE (issue 44-h5-golive-readiness).
 *
 * THE NAMES ARE NOT INVENTED HERE. Every one was found by grepping the app,
 * and the grep is worth writing down because two of the names Boss might
 * expect do not exist:
 *
 *   RAZORPAY_KEY_ID          src/lib/purchases/razorpay-payments.ts:145
 *   RAZORPAY_KEY_SECRET      src/lib/purchases/razorpay-payments.ts:146
 *   RAZORPAY_WEBHOOK_SECRET  src/lib/purchases/webhook.ts:254
 *   RAZORPAY_PLAN_PRO_ID     src/lib/purchases/razorpay-payments.ts:81
 *   RAZORPAY_PLAN_AI_ID      src/lib/purchases/razorpay-payments.ts:80
 *   RAZORPAY_CHECKOUT_SRC    NOT AN ENV VAR. src/lib/purchases/types.ts:36
 *                            is a plain constant holding
 *                            https://checkout.razorpay.com/v1/checkout.js.
 *                            There is nothing to set in Vercel, and a
 *                            preflight that asked for it would send Boss
 *                            hunting for a variable that cannot exist.
 *
 * NO VALUE IS EVER PRINTED. The presence check says "set" or "missing" and
 * nothing else. The mode check says `test`, `live`, `mixed` or `missing`,
 * which is a fact about the first nine characters of a key id and is the one
 * fact Boss has to know.
 *
 * WHY MODE IS READ FROM THE PREFIX AND NOT FROM RAZORPAY. Asking Razorpay
 * would mean a network call with a live key from a preflight, which is the
 * kind of thing that ends up in a log. `rzp_test_` and `rzp_live_` are
 * Razorpay's own documented key-id prefixes, they are in front of the eyes
 * anyway, and reading them costs nothing and risks nothing.
 */
import type { Check, ExpectMode } from './types';
import { RAZORPAY_CHECKOUT_SRC } from '@/lib/purchases/types';

/** Without all three, no money can move at all. */
export const RAZORPAY_REQUIRED_ENV = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
] as const;

/**
 * Needed only for the two subscription plans (V18, issue 28). A mock-set sale
 * works without them, so a missing one is reported and not failed.
 */
export const RAZORPAY_OPTIONAL_ENV = ['RAZORPAY_PLAN_PRO_ID', 'RAZORPAY_PLAN_AI_ID'] as const;

export type KeyMode = 'test' | 'live' | 'mixed' | 'missing' | 'unknown';

type Env = Record<string, string | undefined>;

function isSet(env: Env, name: string): boolean {
  const value = env[name]?.trim();
  return typeof value === 'string' && value.length > 0;
}

/**
 * `test`, `live`, or `unknown` from a Razorpay credential's prefix.
 *
 * `unknown` is the normal answer for a key SECRET: Razorpay's secrets carry no
 * prefix. That is why a mix is only called out when BOTH halves name a mode.
 */
export function prefixMode(value: string | undefined): 'test' | 'live' | 'unknown' {
  const trimmed = value?.trim() ?? '';
  if (trimmed.startsWith('rzp_test_')) return 'test';
  if (trimmed.startsWith('rzp_live_')) return 'live';
  return 'unknown';
}

export interface KeyModeFound {
  readonly mode: KeyMode;
  readonly keyIdMode: 'test' | 'live' | 'unknown';
  readonly secretMode: 'test' | 'live' | 'unknown';
}

/**
 * Which Razorpay world the app is pointed at.
 *
 * `mixed` is the dangerous one and it is the reason this function exists. A
 * test key id with a live secret authenticates against nothing, so orders
 * fail in a way that looks like an outage; a live key id with a test secret is
 * worse, because the checkout can open against real money with a secret that
 * cannot verify it. Either way, nothing about it is recoverable at runtime, so
 * it is a FAIL in both expect modes.
 */
export function detectKeyMode(env: Env): KeyModeFound {
  const keyIdMode = prefixMode(env.RAZORPAY_KEY_ID);
  const secretMode = prefixMode(env.RAZORPAY_KEY_SECRET);

  if (!isSet(env, 'RAZORPAY_KEY_ID') || !isSet(env, 'RAZORPAY_KEY_SECRET')) {
    return { mode: 'missing', keyIdMode, secretMode };
  }
  if (keyIdMode !== 'unknown' && secretMode !== 'unknown' && keyIdMode !== secretMode) {
    return { mode: 'mixed', keyIdMode, secretMode };
  }
  // The id is the half that always carries a prefix, so it decides. A secret
  // that happens to carry one and agrees changes nothing.
  if (keyIdMode !== 'unknown') return { mode: keyIdMode, keyIdMode, secretMode };
  if (secretMode !== 'unknown') return { mode: secretMode, keyIdMode, secretMode };
  return { mode: 'unknown', keyIdMode, secretMode };
}

/** Which Razorpay names are set, by name, with no value anywhere. */
export function checkRazorpayEnv(env: Env): Check {
  const missing = RAZORPAY_REQUIRED_ENV.filter((name) => !isSet(env, name));
  const missingOptional = RAZORPAY_OPTIONAL_ENV.filter((name) => !isSet(env, name));

  const planNote =
    missingOptional.length === 0
      ? 'both plan ids set'
      : 'no subscription plan id for ' + missingOptional.join(' and ') + ' (' + RAZORPAY_OPTIONAL_ENV[0] + ' is only needed for V18 plans)';

  if (missing.length > 0) {
    return {
      name: 'Razorpay env',
      status: 'FAIL',
      detail: 'missing: ' + missing.join(', ') + '; ' + planNote,
      fix: 'add ' + missing.join(', ') + ' in Vercel (Project, Settings, Environment Variables) and in web/.env.local for the laptop jobs',
    };
  }

  return {
    name: 'Razorpay env',
    status: 'PASS',
    detail: 'all 3 required names are set; ' + planNote,
  };
}

/**
 * The checkout script URL.
 *
 * Reported so the preflight table answers the question rather than leaving
 * Boss to go and check: it is a code constant, there is nothing to set.
 */
export function checkCheckoutSrc(): Check {
  return {
    name: 'checkout script',
    status: 'PASS',
    detail: 'code constant, not env: ' + RAZORPAY_CHECKOUT_SRC,
  };
}

export interface KeyModeCheckInput {
  readonly env: Env;
  readonly expect: ExpectMode;
  /** True when every OTHER check in this run is a PASS. */
  readonly othersClear: boolean;
}

/**
 * The single most important row in the table.
 *
 * `rzp_live_` is a PASS only when every other money check is already clear,
 * because live keys with an open gate behind them is the exact shape of a
 * wrong go-live: real cards, and a reconcile nobody has read.
 */
export function checkKeyMode({ env, expect, othersClear }: KeyModeCheckInput): Check {
  const name = 'Razorpay key MODE';
  const { mode, keyIdMode, secretMode } = detectKeyMode(env);

  if (mode === 'missing') {
    return {
      name,
      status: 'FAIL',
      detail: 'no key pair at all, so no mode to read',
      fix: 'set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
    };
  }

  if (mode === 'mixed') {
    return {
      name,
      status: 'FAIL',
      detail: 'MIXED pair: key id is ' + keyIdMode + ', key secret is ' + secretMode,
      fix: 'take both halves from the SAME Razorpay dashboard mode and paste them together, never one at a time',
    };
  }

  if (mode === 'unknown') {
    return {
      name,
      status: 'WARN',
      detail: 'key id carries no rzp_test_ or rzp_live_ prefix, so the mode cannot be read',
      fix: 'check RAZORPAY_KEY_ID was pasted whole; a Razorpay key id always starts rzp_test_ or rzp_live_',
    };
  }

  if (mode === 'test') {
    if (expect === 'live') {
      return {
        name,
        status: 'FAIL',
        detail: 'TEST keys are in place but --expect live was asked for',
        fix: 'swap RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to the live values in Vercel, redeploy, then run this again',
      };
    }
    return {
      name,
      status: 'WARN',
      detail: 'test mode, no real money',
    };
  }

  // mode === 'live'
  if (!othersClear) {
    return {
      name,
      status: 'FAIL',
      detail: 'LIVE keys are in place while other money checks are not clear',
      fix: 'clear every other row in this table first, or roll back to the test keys (see web/GO-LIVE.md, "Roll back")',
    };
  }
  if (expect === 'test') {
    return {
      name,
      status: 'FAIL',
      detail: 'LIVE keys are in place but --expect test was asked for',
      fix: 'run with --expect live if this is deliberate, or roll back to the test keys',
    };
  }
  return { name, status: 'PASS', detail: 'live mode, real money, and every other money check is clear' };
}
