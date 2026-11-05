/**
 * The browser-side mock sets client (issue 15-mock-sets-authoring).
 *
 * `fetch` is injected, so nothing leaves the machine. What is pinned:
 *
 *  * the set id goes in the URL PATH, so a caller cannot move a test to
 *    another set by editing JSON.
 *  * a 409 becomes one of our own short CODES, never a server message.
 *  * the two publish 409s are told apart, because they are two different
 *    lines for the teacher to read.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserMocksClient,
  mockSetPublishPath,
  mockSetTestsPath,
  TEACHER_MOCK_SETS_PATH,
} from '../browser-mocks-client';

const EXAM = 'a4000001-0000-4000-8000-000000000001';
const SET = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';

const EDIT = { id: null, examId: EXAM, title: 'Full length set 1', priceInr: 349 };

const DRAFT = { title: 'Test 1', position: 1, durationMin: 120, isFreeSample: true };

const STORED_SET = {
  id: SET,
  teacherId: TEACHER,
  examId: EXAM,
  title: 'Full length set 1',
  priceInr: 349,
  status: 'draft' as const,
};

const STORED_TEST = {
  id: '33333333-3333-4333-8333-333333333333',
  setId: SET,
  title: 'Test 1',
  position: 1,
  durationMin: 120,
  isFreeSample: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the paths', () => {
  it('escape the set id', () => {
    expect(TEACHER_MOCK_SETS_PATH).toBe('/api/teacher/mock-sets');
    expect(mockSetTestsPath(SET)).toBe(`/api/teacher/mock-sets/${SET}/tests`);
    expect(mockSetPublishPath('a b')).toBe('/api/teacher/mock-sets/a%20b/publish');
  });
});

describe('createBrowserMocksClient', () => {
  it('posts a set as JSON and hands the stored row back', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, set: STORED_SET }));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    expect(await client.saveSet(EDIT)).toEqual(STORED_SET);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TEACHER_MOCK_SETS_PATH);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(EDIT);
  });

  it('turns a 409 on a set into the duplicate CODE', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'duplicate' }, 409));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    await expect(client.saveSet(EDIT)).rejects.toThrow(/^duplicate$/);
  });

  it('never echoes a server message for a failed set save', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'policy "mock_sets_insert_own" blocked this' }, 502),
    );
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    await expect(client.saveSet(EDIT)).rejects.toThrow(/^Request failed with status 502$/);
  });

  it('puts the set id in the PATH when adding a test', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, test: STORED_TEST }));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    expect(await client.saveTest(SET, DRAFT)).toEqual(STORED_TEST);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(mockSetTestsPath(SET));
    // The set id is NOT in the body: the route reads it from the path.
    expect(JSON.parse(String(init.body))).toEqual(DRAFT);
  });

  it('turns a 409 on a test into the duplicate-position CODE', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'duplicate position' }, 409));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    await expect(client.saveTest(SET, DRAFT)).rejects.toThrow(/^duplicate-position$/);
  });

  it('publishes and reports how many questions went live', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, published: 40 }));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    expect(await client.publish(SET)).toBe(40);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(mockSetPublishPath(SET));
    expect(init.method).toBe('POST');
  });

  it('tells the two publish 409s apart', async () => {
    const unchecked = vi.fn(async () => json({ error: 'unchecked' }, 409));
    await expect(
      createBrowserMocksClient(unchecked as unknown as typeof fetch).publish(SET),
    ).rejects.toThrow(/^unchecked$/);

    const empty = vi.fn(async () => json({ error: 'no tests' }, 409));
    await expect(
      createBrowserMocksClient(empty as unknown as typeof fetch).publish(SET),
    ).rejects.toThrow(/^no-tests$/);
  });

  it('turns a 404 into the not-found CODE', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'not found' }, 404));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    await expect(client.publish(SET)).rejects.toThrow(/^not-found$/);
  });

  it('reads a reply with no number as zero published, never NaN', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);
    expect(await client.publish(SET)).toBe(0);
  });

  it('treats a 200 with no row as a failure, so a screen never says saved', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const client = createBrowserMocksClient(fetchImpl as unknown as typeof fetch);

    await expect(client.saveSet(EDIT)).rejects.toThrow();
    await expect(client.saveTest(SET, DRAFT)).rejects.toThrow();
  });
});
