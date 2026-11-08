/**
 * Server-side `MockSetsClient` over the Supabase REST API
 * (issue 15-mock-sets-authoring).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `mock_sets_*` and `mock_tests_*` policies in `0015_mock_sets.sql`.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `mock_sets.teacher_id` is the row owner.
 *
 * Two rules this file must not break:
 *
 *  * A SAVE never sends a `status`. A set goes live only through
 *    `publish_mock_set()`.
 *  * A price is checked against V11's band HERE as well, so a bug past the
 *    route cannot put Rs 500 in a sale. `mock_sets_price_check` is the gate;
 *    this throws before the request so no half-priced row is even attempted.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status or a Postgres
 * ERROR CODE, never a response body (a Postgres message quotes policy and
 * constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  canBeFreeSample,
  DEFAULT_SHARE_PCT,
  isMockSetStatus,
  MAX_PRICE_INR,
  MIN_PRICE_INR,
  type MockSet,
  type MockSetEdit,
  type MockSetsClient,
  type MockTest,
  type MockTestDraft,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETS = '/rest/v1/mock_sets';
const TESTS = '/rest/v1/mock_tests';
const TEACHERS = '/rest/v1/teachers';
const PUBLISH = '/rest/v1/rpc/publish_mock_set';

/** Never `select=*`, so a column added later cannot leak by accident. */
const SET_COLUMNS = 'id,teacher_id,exam_id,title,price_inr,status,archived_at';
const TEST_COLUMNS = 'id,set_id,title,position,duration_min,is_free_sample,archived_at';

/**
 * The Postgres error codes `publish_mock_set()` raises -> the NAME the route
 * handler switches on.
 *
 * A code, not a message: the message is English prose that may be reworded,
 * and reading it would also mean reading a body that can quote constraint
 * names.
 *
 *  23514 check_violation                  -> a question is still unchecked
 *  55000 object_not_in_prerequisite_state -> the set has no tests
 *  42501 insufficient_privilege           -> somebody else's set
 *  P0002 no_data_found                    -> no such set (for this caller)
 */
const PUBLISH_ERRORS: Record<string, string> = {
  '23514': 'PublishUnchecked',
  '55000': 'PublishEmpty',
  '42501': 'PublishForbidden',
  P0002: 'PublishForbidden',
};

export interface SupabaseMocksClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface SetRow {
  id?: unknown;
  teacher_id?: unknown;
  exam_id?: unknown;
  title?: unknown;
  price_inr?: unknown;
  status?: unknown;
  archived_at?: unknown;
}

interface TestRow {
  id?: unknown;
  set_id?: unknown;
  title?: unknown;
  position?: unknown;
  duration_min?: unknown;
  is_free_sample?: unknown;
  archived_at?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** One set row, or null when any field is missing or the wrong shape. */
function readSetRow(raw: SetRow): MockSet | null {
  const id = text(raw?.id);
  const teacherId = text(raw?.teacher_id);
  const examId = text(raw?.exam_id);
  const title = text(raw?.title);
  const priceInr = whole(raw?.price_inr);
  if (!id || !teacherId || !examId || !title || priceInr === null) return null;
  // A status we do not know is not trusted: it could mean "live" one day.
  if (!isMockSetStatus(raw.status)) return null;

  const archivedAt = text(raw.archived_at);
  return {
    id,
    teacherId,
    examId,
    title,
    priceInr,
    status: raw.status,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function readTestRow(raw: TestRow): MockTest | null {
  const id = text(raw?.id);
  const setId = text(raw?.set_id);
  const title = text(raw?.title);
  const position = whole(raw?.position);
  const durationMin = whole(raw?.duration_min);
  if (!id || !setId || !title || position === null || durationMin === null) return null;

  return {
    id,
    setId,
    title,
    position,
    durationMin,
    // Fails CLOSED: anything that is not exactly `true` is a PAID test, so a
    // broken row never gives a test away.
    isFreeSample: raw.is_free_sample === true,
    ...(text(raw.archived_at) ? { archivedAt: text(raw.archived_at) } : {}),
  };
}

export function createSupabaseMocksClient(
  options: SupabaseMocksClientOptions,
): MockSetsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function rows<T>(table: string, query: string): Promise<T[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(`${found.url}${table}?${query}`, {
      method: 'GET',
      headers: headers({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as T[]) : [];
  }

  async function listSets(query: string): Promise<MockSet[]> {
    const raw = await rows<SetRow>(SETS, `select=${SET_COLUMNS}${query}`);
    const out: MockSet[] = [];
    for (const one of raw) {
      // A row we cannot read is DROPPED, never half-filled: a set shown with
      // a made-up price is a set sold at the wrong price.
      const set = readSetRow(one);
      if (set) out.push(set);
    }
    return out;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listMine() {
      if (!UUID_RE.test(options.userId)) return [];
      return listSets(
        `&teacher_id=eq.${encodeURIComponent(options.userId)}&order=created_at.desc`,
      );
    },

    async listLiveForTeacher(teacherId: string) {
      if (!UUID_RE.test(teacherId)) return [];
      // `status=eq.live` as well as the policy. Belt and braces: a teacher
      // opening their OWN portfolio page would otherwise see their drafts
      // there, which is not what a student sees.
      return listSets(
        `&teacher_id=eq.${encodeURIComponent(teacherId)}` +
          '&status=eq.live&order=created_at.desc',
      );
    },

    async readOne(setId: string) {
      // The id goes into a URL, so it is checked against the UUID shape first.
      if (!UUID_RE.test(setId)) return null;
      const found = await listSets(`&id=eq.${encodeURIComponent(setId)}&limit=1`);
      return found[0] ?? null;
    },

    async listTests(setId: string) {
      if (!UUID_RE.test(setId)) return [];
      const raw = await rows<TestRow>(
        TESTS,
        `select=${TEST_COLUMNS}&set_id=eq.${encodeURIComponent(setId)}` +
          '&order=position.asc',
      );
      const out: MockTest[] = [];
      for (const one of raw) {
        const test = readTestRow(one);
        if (test) out.push(test);
      }
      return out;
    },

    // Issue 17-practice-mode: the mock player is reached by TEST id, so it
    // needs the row on its own to find the set and then the exam's marking.
    async readTest(testId: string) {
      if (!UUID_RE.test(testId)) return null;
      const raw = await rows<TestRow>(
        TESTS,
        `select=${TEST_COLUMNS}&id=eq.${encodeURIComponent(testId)}&limit=1`,
      );
      // Null, never a half-filled row: a test shown with a made-up duration
      // is a test a student cannot trust.
      return raw.length === 0 ? null : readTestRow(raw[0]);
    },

    async saveSet(edit: MockSetEdit) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(edit.examId)) throw new Error('exam id must be a uuid');
      if (edit.id !== null && !UUID_RE.test(edit.id)) {
        throw new Error('set id must be a uuid');
      }
      // V11's band, checked again here. A price is money, so it gets the one
      // extra line.
      if (
        !Number.isInteger(edit.priceInr) ||
        edit.priceInr < MIN_PRICE_INR ||
        edit.priceInr > MAX_PRICE_INR
      ) {
        throw new Error('price must be between 299 and 399');
      }

      const existing = edit.id;
      const target =
        existing === null
          ? `${url}${SETS}?select=${SET_COLUMNS}`
          : `${url}${SETS}?id=eq.${encodeURIComponent(existing)}&select=${SET_COLUMNS}`;

      const res = await doFetch(target, {
        method: existing === null ? 'POST' : 'PATCH',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify(
          existing === null
            ? {
                // The owner comes from the session, never from the body.
                teacher_id: options.userId,
                exam_id: edit.examId,
                title: edit.title,
                price_inr: edit.priceInr,
                // No `status`: a set goes live only through
                // publish_mock_set().
              }
            : // On an update, neither the owner nor the exam moves: the
              // `mock_sets_update_own` policy would refuse a new owner anyway,
              // and not sending them means a bug here cannot try. The exam
              // stays put because moving it would change what the set IS.
              { title: edit.title, price_inr: edit.priceInr },
        ),
        cache: 'no-store',
      });

      if (res.status === 409) {
        // `mock_sets_title_unique`. Named, so the route can answer 409
        // without reading a Postgres message that quotes the constraint.
        throw Object.assign(new Error('you already have a set with that name'), {
          name: 'MockSetConflict',
        });
      }
      if (!res.ok) {
        throw new Error('Supabase mock set save failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as SetRow) : (body as SetRow);
      const stored = readSetRow(first ?? {});
      // An empty array from a PATCH means RLS hid the row: somebody else's
      // set. Treated as a failure, so the screen never shows "saved".
      if (!stored) throw new Error('Supabase mock set save returned no row');
      return stored;
    },

    async saveTest(setId: string, draft: MockTestDraft) {
      const { url } = required();
      if (!UUID_RE.test(setId)) throw new Error('set id must be a uuid');
      // V11, checked again: only Test 1 may be free.
      if (draft.isFreeSample && !canBeFreeSample(draft.position)) {
        throw new Error('only test 1 can be the free sample');
      }

      const res = await doFetch(`${url}${TESTS}?select=${TEST_COLUMNS}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify({
          // The parent comes from the URL path, never from the body, so a
          // caller cannot hang a test on another set by editing JSON.
          set_id: setId,
          title: draft.title,
          position: draft.position,
          duration_min: draft.durationMin,
          is_free_sample: draft.isFreeSample,
        }),
        cache: 'no-store',
      });

      if (res.status === 409) {
        // `mock_tests_set_position_idx`.
        throw Object.assign(new Error('that test number is taken'), {
          name: 'MockTestConflict',
        });
      }
      if (!res.ok) {
        throw new Error('Supabase mock test save failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as TestRow) : (body as TestRow);
      const stored = readTestRow(first ?? {});
      if (!stored) throw new Error('Supabase mock test save returned no row');
      return stored;
    },

    async publishSet(setId: string) {
      const { url } = required();
      if (!UUID_RE.test(setId)) throw new Error('set id must be a uuid');

      const res = await doFetch(`${url}${PUBLISH}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({ set_id: setId }),
        cache: 'no-store',
      });

      if (!res.ok) {
        // Read the CODE only. The message beside it is prose and may quote a
        // constraint name, so it never leaves this function.
        let code = '';
        try {
          const body = (await res.json()) as { code?: unknown };
          if (typeof body?.code === 'string') code = body.code;
        } catch {
          // No JSON body. Falls through to the generic error below.
        }

        const name = PUBLISH_ERRORS[code];
        if (name) throw Object.assign(new Error('publish refused'), { name });
        throw new Error('Supabase publish failed with status ' + res.status);
      }

      // The function returns a plain integer, which PostgREST sends as a bare
      // JSON number.
      const body = (await res.json()) as unknown;
      if (typeof body === 'number' && Number.isInteger(body)) return body;
      if (typeof body === 'string' && /^\d+$/.test(body)) return Number(body);
      return 0;
    },

    async readMyShare() {
      // X3's default, used for every failure. The estimate line always has a
      // number to show, and a missing read never blanks the pricing screen.
      if (!UUID_RE.test(options.userId)) return DEFAULT_SHARE_PCT;

      const raw = await rows<{ revenue_share_pct?: unknown }>(
        TEACHERS,
        'select=revenue_share_pct' +
          `&user_id=eq.${encodeURIComponent(options.userId)}&limit=1`,
      );
      const share = whole(raw[0]?.revenue_share_pct);
      if (share === null || share < 0 || share > 100) return DEFAULT_SHARE_PCT;
      return share;
    },
  };
}
