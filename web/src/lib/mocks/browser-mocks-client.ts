/**
 * Browser-side mock sets client (issue 15-mock-sets-authoring).
 *
 * The authoring screens never hold a Supabase key and never see a token. They
 * post to our own route handlers; those read the teacher's access token out of
 * the httpOnly session cookie and let Postgres RLS decide.
 *
 * The SET ID goes in the URL PATH, never in the body, for the test and publish
 * calls. A body is editable in a browser console; the path is what the route
 * reads, and the route hands it to a client that checks the uuid shape before
 * building a URL.
 *
 * Security: the thrown message is a short CODE of ours or the HTTP status, so
 * a Postgres policy name is never echoed into the page. The screen turns each
 * code into one line of Hindi or English.
 */
import type {
  BrowserMockSetsClient,
  MockSet,
  MockSetEdit,
  MockTest,
  MockTestDraft,
} from './types';

export const TEACHER_MOCK_SETS_PATH = '/api/teacher/mock-sets';

/** Our own route for the tests inside one set. */
export function mockSetTestsPath(setId: string): string {
  return `${TEACHER_MOCK_SETS_PATH}/${encodeURIComponent(setId)}/tests`;
}

/** Our own publish route for one set. */
export function mockSetPublishPath(setId: string): string {
  return `${TEACHER_MOCK_SETS_PATH}/${encodeURIComponent(setId)}/publish`;
}

/** Codes the screens turn into one short line. Never a server message. */
export type MocksErrorCode =
  | 'duplicate'
  | 'duplicate-position'
  | 'unchecked'
  | 'no-tests'
  | 'not-found';

function refuse(code: MocksErrorCode): never {
  throw new Error(code);
}

export function createBrowserMocksClient(fetchImpl?: typeof fetch): BrowserMockSetsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async saveSet(edit: MockSetEdit): Promise<MockSet> {
      const res = await doFetch(TEACHER_MOCK_SETS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edit),
      });

      if (res.status === 409) refuse('duplicate');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { set?: MockSet };
      // A 200 with no row means something went wrong upstream. Treated as a
      // failure, so the screen never shows "saved" over an unsaved set.
      if (!body?.set) throw new Error('Request failed with status ' + res.status);
      return body.set;
    },

    async saveTest(setId: string, draft: MockTestDraft): Promise<MockTest> {
      const res = await doFetch(mockSetTestsPath(setId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });

      if (res.status === 409) refuse('duplicate-position');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { test?: MockTest };
      if (!body?.test) throw new Error('Request failed with status ' + res.status);
      return body.test;
    },

    async publish(setId: string): Promise<number> {
      const res = await doFetch(mockSetPublishPath(setId), { method: 'POST' });

      if (res.status === 404) refuse('not-found');
      if (res.status === 409) {
        // Which 409 it is decides which line the teacher reads: "check every
        // question" or "add a test first".
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        refuse(body?.error === 'no tests' ? 'no-tests' : 'unchecked');
      }
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { published?: unknown };
      return typeof body?.published === 'number' ? body.published : 0;
    },
  };
}
