/**
 * Issue 08-videos-tile: the title comes from YouTube oEmbed.
 *
 * "Test that proves it", second half: a FAKE oEmbed fills the title. `fetch`
 * is injected, so this file makes no real network call and holds no key
 * (web/CLAUDE.md). oEmbed needs no key at all, which is why V6 can use it and
 * the YouTube Data API stays out of scope.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOEmbedVideoMeta, OEMBED_ENDPOINT } from '../oembed-video-meta';
import { youTubeWatchUrl } from '../youtube-url';

const ID = 'dQw4w9WgXcQ';

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('createOEmbedVideoMeta', () => {
  it('fills the title from the oEmbed answer', async () => {
    const fetchImpl = fakeFetch({ title: 'Indian Constitution in 10 minutes' });
    const meta = createOEmbedVideoMeta({ fetchImpl });

    await expect(meta.readTitle(ID)).resolves.toBe('Indian Constitution in 10 minutes');
  });

  it('calls the keyless oEmbed endpoint with the watch URL and format=json', async () => {
    const fetchImpl = fakeFetch({ title: 'Polity' });
    await createOEmbedVideoMeta({ fetchImpl }).readTitle(ID);

    const called = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(called.startsWith(OEMBED_ENDPOINT)).toBe(true);
    expect(called).toContain('format=json');
    expect(called).toContain(encodeURIComponent(youTubeWatchUrl(ID)));
    // A key in the URL would mean we used the Data API, which is out of scope.
    expect(called).not.toContain('key=');
  });

  it('trims the title and cuts it to a stored length', async () => {
    const long = 'x'.repeat(400);
    const meta = createOEmbedVideoMeta({ fetchImpl: fakeFetch({ title: '  ' + long + '  ' }) });

    const title = await meta.readTitle(ID);
    expect(title).not.toBeNull();
    expect(title).toBe('x'.repeat(300));
  });

  it('returns null when YouTube answers with a non-200', async () => {
    const meta = createOEmbedVideoMeta({ fetchImpl: fakeFetch({}, { ok: false, status: 404 }) });
    await expect(meta.readTitle(ID)).resolves.toBeNull();
  });

  it('returns null when the answer has no usable title', async () => {
    await expect(
      createOEmbedVideoMeta({ fetchImpl: fakeFetch({ title: 42 }) }).readTitle(ID),
    ).resolves.toBeNull();
    await expect(
      createOEmbedVideoMeta({ fetchImpl: fakeFetch({ title: '   ' }) }).readTitle(ID),
    ).resolves.toBeNull();
    await expect(
      createOEmbedVideoMeta({ fetchImpl: fakeFetch('not an object') }).readTitle(ID),
    ).resolves.toBeNull();
  });

  it('returns null instead of throwing when the network fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(createOEmbedVideoMeta({ fetchImpl }).readTitle(ID)).resolves.toBeNull();
  });

  it('never calls out for an id it would not have parsed', async () => {
    const fetchImpl = fakeFetch({ title: 'nope' });
    await expect(createOEmbedVideoMeta({ fetchImpl }).readTitle('../../evil')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
