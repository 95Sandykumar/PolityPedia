/**
 * Issue 78-installable-app: the service worker.
 * It must cache ONE static page and pass everything else through untouched,
 * so auth cookies, redirects, signed-in HTML and /api never meet the cache.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown) => void;

const SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

function boot(options: { fetchImpl?: () => Promise<unknown> } = {}) {
  const handlers: Record<string, Handler> = {};
  const cache = { add: vi.fn(async () => {}), put: vi.fn(async () => {}), addAll: vi.fn(async () => {}) };
  const offlineResponse = { offline: true };
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async () => offlineResponse),
    keys: vi.fn(async () => ['politypedia-offline-v0', 'politypedia-offline-v1', 'other']),
    delete: vi.fn(async () => true),
  };
  const self = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: vi.fn(async () => {}),
  };
  const fetchMock = vi.fn(options.fetchImpl ?? (async () => ({ status: 200 })));
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetchMock);
  return { handlers, cache, caches, fetchMock, offlineResponse };
}

function fetchEvent(url: string, init: { mode?: string; method?: string } = {}) {
  const respondWith = vi.fn();
  return {
    respondWith,
    request: { url: `https://app.test${url}`, mode: init.mode ?? 'cors', method: init.method ?? 'GET' },
  };
}

describe('service worker', () => {
  it('caches only the offline page on install', async () => {
    const { handlers, cache } = boot();
    let work: Promise<unknown> = Promise.resolve();
    handlers.install({ waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
    expect(cache.add).toHaveBeenCalledTimes(1);
    expect(cache.add).toHaveBeenCalledWith('/offline.html');
    expect(cache.addAll).not.toHaveBeenCalled();
  });

  it('removes only old versions of its own cache on activate', async () => {
    const { handlers, caches } = boot();
    let work: Promise<unknown> = Promise.resolve();
    handlers.activate({ waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
    expect(caches.delete).toHaveBeenCalledWith('politypedia-offline-v0');
    expect(caches.delete).not.toHaveBeenCalledWith('other');
    expect(caches.delete).not.toHaveBeenCalledWith('politypedia-offline-v1');
  });

  it.each([
    ['an /api GET', '/api/attempts', { mode: 'cors' }],
    ['an /api navigation', '/api/auth/callback', { mode: 'navigate' }],
    ['a static asset', '/_next/static/chunk.js', { mode: 'no-cors' }],
    ['a POST form', '/auth/sign-out', { mode: 'navigate', method: 'POST' }],
    ['a data fetch for a signed-in page', '/me/plans', { mode: 'cors' }],
  ])('passes %s straight through', (_name, url, init) => {
    const { handlers, cache, fetchMock } = boot();
    const event = fetchEvent(url, init);
    handlers.fetch(event);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('returns the network answer for a page load, and never stores it', async () => {
    const networkResponse = { status: 200, signedInHtml: true };
    const { handlers, cache, caches, fetchMock } = boot({ fetchImpl: async () => networkResponse });
    const event = fetchEvent('/me', { mode: 'navigate' });
    handlers.fetch(event);
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    await expect(event.respondWith.mock.calls[0][0]).resolves.toBe(networkResponse);
    expect(fetchMock).toHaveBeenCalledWith(event.request);
    expect(cache.put).not.toHaveBeenCalled();
    expect(caches.match).not.toHaveBeenCalled();
  });

  it('shows the offline page when a page load fails', async () => {
    const { handlers, caches, offlineResponse } = boot({
      fetchImpl: async () => {
        throw new TypeError('offline');
      },
    });
    const event = fetchEvent('/practice', { mode: 'navigate' });
    handlers.fetch(event);
    await expect(event.respondWith.mock.calls[0][0]).resolves.toBe(offlineResponse);
    expect(caches.match).toHaveBeenCalledWith('/offline.html');
  });
});
