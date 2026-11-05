/**
 * The decision logic behind the three mock set routes
 * (issue 15-mock-sets-authoring):
 *
 *   POST /api/teacher/mock-sets                      -> create or reprice a set
 *   POST /api/teacher/mock-sets/<setId>/tests        -> add one test
 *   POST /api/teacher/mock-sets/<setId>/publish      -> the set goes live
 *
 * Kept out of the route files so the tests can drive it directly, the same
 * split as `questions-route.ts` / its routes.
 *
 * Order of checks: session, role, config, then the body. A body is never
 * looked at before we know who is asking.
 *
 * WHO the set belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to sell under teacher B's name. A
 * `status` in the body is dropped too (`readSetDraft`): a set goes live only
 * through `publish_mock_set()`, which refuses an empty set and refuses while
 * any question is unchecked (V9, V11).
 *
 * A PRICE OUTSIDE THE BAND IS A 400, NOT A CLAMP. Clamping would charge a
 * student a price the teacher never chose, which is the one mistake in a
 * pricing screen that costs real money.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `mock_sets_*` and `mock_tests_*` policies plus `mock_sets_price_check` and
 * `mock_tests_free_sample_check` inside Postgres. Replies carry a fixed short
 * word, so a policy name, a constraint name or a Postgres message never
 * reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  readSetDraft,
  readTestDraft,
  type MockSet,
  type MockSetsClient,
  type MockTest,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Refusal = { status: number; body: { error: string } };

export interface SaveMockSetInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: MockSetsClient;
}

export interface SaveMockSetReply {
  status: number;
  body: { ok: true; set: MockSet } | { error: string };
}

export interface SaveMockTestInput {
  setId: string;
  body: unknown;
  session: AuthSession | null;
  client: MockSetsClient;
}

export interface SaveMockTestReply {
  status: number;
  body: { ok: true; test: MockTest } | { error: string };
}

export interface PublishMockSetInput {
  setId: string;
  session: AuthSession | null;
  client: MockSetsClient;
}

export interface PublishMockSetReply {
  status: number;
  body: { ok: true; published: number } | { error: string };
}

/** Null when the caller may write, or the reply that turns them away. */
function refuseCaller(
  session: AuthSession | null,
  client: MockSetsClient,
): Refusal | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  // A student owns no sets: `mock_sets.teacher_id` references
  // `teachers.user_id`, so Postgres would refuse it anyway. An admin outranks
  // a teacher and is let through.
  if (session.role === 'student') return { status: 403, body: { error: 'teachers only' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  return null;
}

export async function handleSaveMockSet({
  body,
  session,
  client,
}: SaveMockSetInput): Promise<SaveMockSetReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  // Drops a `teacherId`, a `status` and anything else that is not one of the
  // three fields a teacher may set. A price outside V11's band is refused.
  const draft = readSetDraft(body);
  if (!draft) return { status: 400, body: { error: 'bad request' } };

  // Null means "a new set". Anything else must be a real uuid, because it
  // goes into a URL.
  let id: string | null = null;
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.id !== null && raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) {
      return { status: 400, body: { error: 'bad request' } };
    }
    id = raw.id;
  }

  try {
    const set = await client.saveSet({ id, ...draft });
    return { status: 200, body: { ok: true, set } };
  } catch (cause) {
    // `mock_sets_title_unique`: that title is taken under that exam.
    if ((cause as Error)?.name === 'MockSetConflict') {
      return { status: 409, body: { error: 'duplicate' } };
    }
    // Fixed message: the thrown error may quote a policy.
    return { status: 502, body: { error: 'save failed' } };
  }
}

export async function handleSaveMockTest({
  setId,
  body,
  session,
  client,
}: SaveMockTestInput): Promise<SaveMockTestReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  if (typeof setId !== 'string' || !UUID_RE.test(setId)) {
    return { status: 400, body: { error: 'bad request' } };
  }

  // Refuses a free sample at any position but 1 (V11).
  const draft = readTestDraft(body);
  if (!draft) return { status: 400, body: { error: 'bad request' } };

  try {
    const test = await client.saveTest(setId, draft);
    return { status: 200, body: { ok: true, test } };
  } catch (cause) {
    // `mock_tests_set_position_idx`: that position is already in the set.
    if ((cause as Error)?.name === 'MockTestConflict') {
      return { status: 409, body: { error: 'duplicate position' } };
    }
    return { status: 502, body: { error: 'save failed' } };
  }
}

/**
 * Publish one mock set.
 *
 * Every refusal comes from `publish_mock_set()` inside Postgres, not from a
 * count done here: the screen greys the button out, and this is the real gate
 * behind it. So a question that was unchecked one second ago is decided by the
 * database and not by a stale page.
 */
export async function handlePublishMockSet({
  setId,
  session,
  client,
}: PublishMockSetInput): Promise<PublishMockSetReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  if (typeof setId !== 'string' || !UUID_RE.test(setId)) {
    return { status: 400, body: { error: 'bad request' } };
  }

  try {
    const published = await client.publishSet(setId);
    return { status: 200, body: { ok: true, published } };
  } catch (cause) {
    switch ((cause as Error)?.name) {
      // V9: publish stays off until every question is checked.
      case 'PublishUnchecked':
        return { status: 409, body: { error: 'unchecked' } };
      // A live set with no tests is one a student pays Rs 299 for and cannot
      // open.
      case 'PublishEmpty':
        return { status: 409, body: { error: 'no tests' } };
      // 404, not 403: "that set exists but is not yours" is nobody's
      // business, and a student asking gets the same answer as a stranger.
      case 'PublishForbidden':
        return { status: 404, body: { error: 'not found' } };
      default:
        return { status: 502, body: { error: 'publish failed' } };
    }
  }
}
