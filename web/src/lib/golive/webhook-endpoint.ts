/**
 * The deployed webhook endpoint, poked once with an UNSIGNED body
 * (issue 44-h5-golive-readiness).
 *
 * This is the only outside call the preflight makes, and it is safe by
 * construction. design.md A2 and `src/lib/purchases/webhook.ts`: the HMAC
 * signature is checked FIRST and a wrong one is a 400 with nothing written,
 * not even the de-dupe row. So an unsigned POST proves three things at once:
 *
 *   the route is deployed and awake,
 *   it refuses a stranger,
 *   and it writes nothing while proving it.
 *
 * WHAT EACH ANSWER MEANS.
 *
 *   4xx   PASS. The signature gate did its job.
 *   503   FAIL. The route's own "no RAZORPAY_WEBHOOK_SECRET here". On go-live
 *         day every real Razorpay delivery would bounce off this, Razorpay
 *         would retry and give up, and a student who paid would never get in.
 *   5xx   FAIL. Something in the route is broken before the signature check.
 *   2xx   FAIL, and the loudest one. An unsigned body being ACCEPTED means
 *         anybody on the internet can open a mock set for free.
 *   no answer at all
 *         WARN. A laptop with no internet, a site not deployed yet, a DNS
 *         blip. Not proof of a problem, so not a FAIL.
 */
import type { Check } from './types';

/** `src/app/api/webhooks/razorpay/route.ts`. */
export const WEBHOOK_PATH = '/api/webhooks/razorpay';

/** Where the app is deployed today (ticket H2). Overridden by --site. */
export const DEFAULT_SITE_URL = 'https://politypedia.vercel.app';

/** Trim, drop a trailing slash, and fall back to the deployed site. */
export function normaliseSite(url: string | undefined | null): string {
  const trimmed = url?.trim() ?? '';
  if (trimmed === '') return DEFAULT_SITE_URL;
  return trimmed.replace(/\/+$/, '');
}

export interface WebhookEndpointInput {
  readonly siteUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds before the probe gives up and answers WARN. */
  readonly timeoutMs?: number;
}

export async function checkWebhookEndpoint({
  siteUrl,
  fetchImpl,
  timeoutMs = 10_000,
}: WebhookEndpointInput): Promise<Check> {
  const name = 'webhook endpoint';
  const url = normaliseSite(siteUrl) + WEBHOOK_PATH;
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  let status: number;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      // No signature header on purpose. An EMPTY JSON object, so there is
      // nothing in the body that could be mistaken for a real event even if
      // the signature check were ever removed.
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch {
    return {
      name,
      status: 'WARN',
      // No error message: a fetch error can carry a proxy URL or a host name
      // that is nobody's business in a terminal somebody screenshots.
      detail: 'could not reach ' + url,
      fix: 'check the site is deployed and this machine is online, then run the preflight again',
    };
  }

  if (status === 503) {
    return {
      name,
      status: 'FAIL',
      detail: 'unsigned POST answered 503, which is the route saying it has no webhook secret',
      fix: 'set RAZORPAY_WEBHOOK_SECRET in Vercel for Production and redeploy, then paste the same value into the Razorpay dashboard webhook',
    };
  }

  if (status >= 500) {
    return {
      name,
      status: 'FAIL',
      detail: 'unsigned POST answered ' + status + ', so the route breaks before the signature check',
      fix: 'read the Vercel runtime logs for /api/webhooks/razorpay and fix the 5xx before going live',
    };
  }

  if (status >= 400) {
    return {
      name,
      status: 'PASS',
      detail: 'unsigned POST answered ' + status + ', so the signature gate refused it',
    };
  }

  return {
    name,
    status: 'FAIL',
    detail: 'unsigned POST answered ' + status + ', so an UNSIGNED body is being accepted',
    fix: 'stop. Do not go live. The signature check in src/lib/purchases/webhook.ts is not running on the deployed site',
  };
}
