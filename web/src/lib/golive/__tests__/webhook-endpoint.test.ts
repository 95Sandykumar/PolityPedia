/**
 * The deployed webhook endpoint, poked with an UNSIGNED body
 * (issue 44-h5-golive-readiness).
 *
 * design.md A2: the signature is checked first and a bad one is a 400. So an
 * unsigned POST is the one safe probe of a live money endpoint: it proves the
 * route is awake and that it refuses a stranger, and it writes nothing.
 *
 * A 5xx is the loud case. 503 is the route's own "no webhook secret here",
 * which on go-live day means Razorpay's real deliveries would bounce.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_URL, WEBHOOK_PATH, checkWebhookEndpoint, normaliseSite } from '../webhook-endpoint';

function reply(status: number): typeof fetch {
  return vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
}

describe('normaliseSite', () => {
  it('drops a trailing slash and falls back to the deployed site', () => {
    expect(normaliseSite('https://x.dev/')).toBe('https://x.dev');
    expect(normaliseSite('  ')).toBe(DEFAULT_SITE_URL);
    expect(normaliseSite(undefined)).toBe(DEFAULT_SITE_URL);
  });
});

describe('checkWebhookEndpoint', () => {
  it('passes on 400, because an unsigned body must be refused', async () => {
    const fetchImpl = reply(400);
    const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('400');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://x.dev' + WEBHOOK_PATH);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('fails on any other 4xx, because Razorpay could not reach the route either', async () => {
    for (const code of [401, 403, 404, 405]) {
      const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl: reply(code) });
      expect(check.status).toBe('FAIL');
      expect(check.detail).toContain(String(code));
    }
  });

  it('fails on 500', async () => {
    const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl: reply(500) });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('500');
  });

  it('fails on 503, the route saying it has no webhook secret', async () => {
    const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl: reply(503) });
    expect(check.status).toBe('FAIL');
    expect(check.fix).toContain('RAZORPAY_WEBHOOK_SECRET');
  });

  it('fails on a 2xx, because an unsigned body must never be accepted', async () => {
    const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl: reply(200) });
    expect(check.status).toBe('FAIL');
  });

  it('warns when the site cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const check = await checkWebhookEndpoint({ siteUrl: 'https://x.dev', fetchImpl });
    expect(check.status).toBe('WARN');
  });
});
