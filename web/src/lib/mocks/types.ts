/**
 * The mock sets contract (issue 15-mock-sets-authoring).
 *
 * V10 and V11: a teacher builds a mock set for one exam, fills it with tests,
 * prices it between Rs 299 and Rs 399, sees roughly what a sale pays them, and
 * publishes. Test 1 may be a free sample.
 *
 * Supabase sits behind the interfaces at the bottom of this file, so the tests
 * fake it: no real network call and no real key anywhere in the suite
 * (web/CLAUDE.md).
 *
 *  * `MockSetsClient`        -- server side, carries the caller's own access
 *                              token, so Postgres RLS is the real gate.
 *  * `BrowserMockSetsClient` -- posts to our own routes and sees no key.
 *
 * The validation here is a COPY of the SQL constraints in 0015, on purpose.
 * The database is the gate; this is so a teacher gets an answer with no round
 * trip, and so a bad shape never reaches the REST call.
 *
 * NOT HERE: taking the money (issues 26 and 27) and handing a set to a batch
 * (issue 19). This file knows what a set COSTS, never what anybody paid.
 */

/** V11: the teacher picks the price, inside this band. Same as 0015's CHECK. */
export const MIN_PRICE_INR = 299;
export const MAX_PRICE_INR = 399;

/**
 * The stepper moves Rs 10 at a time. A comfort for a thumb on a 360 px phone,
 * NOT a database rule: 299 + 10 x 10 lands exactly on 399, so both ends of the
 * band are reachable, and a set already priced at Rs 345 keeps selling at
 * Rs 345.
 */
export const PRICE_STEP_INR = 10;

/**
 * AS6. GST is INSIDE the price the student pays, so the net amount is
 * `price / 1.18`, and the gateway takes about 2% of that. The fee is an
 * ESTIMATE and is labelled as one everywhere it is shown: the real figure
 * depends on the payment method and is not verified.
 */
export const GST_PCT = 18;
export const GATEWAY_FEE_PCT = 2;

/** X3's default. Used when the teacher's own share cannot be read. */
export const DEFAULT_SHARE_PCT = 50;

/** One line on a 360 px phone, so both titles stay short. */
export const MAX_SET_TITLE_LENGTH = 80;
export const MAX_TEST_TITLE_LENGTH = 80;

/** Matches `mock_tests_position_check` in 0015. */
export const MIN_TEST_POSITION = 1;
export const MAX_TEST_POSITION = 100;

/** Matches `mock_tests_duration_check` in 0015. 1 minute to 6 hours. */
export const MIN_DURATION_MIN = 1;
export const MAX_DURATION_MIN = 360;

/** A real paper is 2 to 3 hours, so an hour is a safe starting point. */
export const DEFAULT_DURATION_MIN = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MockSetStatus = 'draft' | 'live';

export function isMockSetStatus(value: unknown): value is MockSetStatus {
  return value === 'draft' || value === 'live';
}

/** One row of `mock_sets`, as the app passes it around. */
export interface MockSet {
  id: string;
  teacherId: string;
  examId: string;
  title: string;
  priceInr: number;
  status: MockSetStatus;
  /** Set when the set was archived (0041). Absent for a set in the normal list. */
  archivedAt?: string | null;
}

/** One row of `mock_tests`. */
export interface MockTest {
  id: string;
  setId: string;
  title: string;
  /** Test 1, 2, 3 ... Unique inside the set. */
  position: number;
  durationMin: number;
  /** V11: the one free test. Position 1 only. */
  isFreeSample: boolean;
  /** Set when the test was archived (0041). Absent otherwise. */
  archivedAt?: string | null;
}

/**
 * What the teacher fills in for a set. No `teacherId` and no `status`: the
 * owner comes from the session cookie, and a set goes live only through
 * `publish_mock_set()`.
 */
export interface MockSetDraft {
  examId: string;
  title: string;
  priceInr: number;
}

/** A draft plus the id of the set being edited, or null for a new one. */
export interface MockSetEdit extends MockSetDraft {
  id: string | null;
}

/** What the teacher fills in for one test inside a set. */
export interface MockTestDraft {
  title: string;
  position: number;
  durationMin: number;
  isFreeSample: boolean;
}

/**
 * The teacher's authoring screen for one set. A page path, not an API one, so
 * the list does not have to know how this slice spells its route.
 */
export function mockSetPath(setId: string): string {
  return `/teacher/mocks/${encodeURIComponent(setId)}`;
}

/** Keeps a price inside the band. A whole rupee: paise are not a price here. */
export function clampPrice(price: number): number {
  // NaN would survive Math.min/Math.max and become the stored price, so it is
  // turned away first and reads as the cheapest set.
  if (!Number.isFinite(price)) return MIN_PRICE_INR;
  return Math.min(MAX_PRICE_INR, Math.max(MIN_PRICE_INR, Math.floor(price)));
}

/**
 * One tap of the stepper. `direction` is +1 or -1.
 *
 * Clamped, never wrapped: the last step up from Rs 395 is Rs 4, not Rs 10, and
 * the button simply stops at the end of the band rather than jumping to the
 * other end.
 */
export function stepPrice(price: number, direction: number): number {
  const from = clampPrice(price);
  return clampPrice(from + Math.sign(direction) * PRICE_STEP_INR);
}

/**
 * What ONE sale pays the teacher, rounded DOWN, in whole rupees.
 *
 * `price / 1.18` strips the GST that sits inside the price, `x 0.98` is the
 * gateway's estimated cut, and the share is applied to what is left (X3:
 * share on net).
 *
 * Rounded DOWN on purpose. The line says "about", and a number that is a
 * rupee low is a small surprise; a number that is a rupee high is a broken
 * promise about money.
 */
export function teacherEarningEstimate(priceInr: number, sharePct: number): number {
  if (!Number.isFinite(priceInr) || !Number.isFinite(sharePct)) return 0;
  if (priceInr <= 0 || sharePct <= 0) return 0;

  const net = priceInr / (1 + GST_PCT / 100);
  const afterFee = net * (1 - GATEWAY_FEE_PCT / 100);
  const share = (afterFee * Math.min(sharePct, 100)) / 100;
  return Math.max(0, Math.floor(share));
}

/** V11: "Test 1 can be a free sample", and position 1 IS Test 1. */
export function canBeFreeSample(position: number): boolean {
  return position === MIN_TEST_POSITION;
}

/**
 * The position a NEW test gets: one past the highest one already there, not
 * the count, so a deleted Test 2 does not cause a clash with
 * `mock_tests_set_position_idx`.
 */
export function nextTestPosition(tests: readonly MockTest[]): number {
  let highest = 0;
  for (const one of tests) if (one.position > highest) highest = one.position;
  return Math.min(highest + 1, MAX_TEST_POSITION);
}

/** Why Publish is off, or null when it is on. */
export type MockPublishBlock = 'no-tests' | 'unchecked' | null;

/**
 * The same two refusals `publish_mock_set()` raises, so the button and the
 * database never disagree. The database is still the gate: this only decides
 * whether the button is greyed out.
 *
 * "No tests" is reported FIRST, because it is the one a brand-new set always
 * hits, and telling a teacher about unchecked questions in a set with no
 * tests at all would be noise.
 *
 * `questions` is every question across the set, already filtered to this set
 * by the caller: a question hanging on another set is not this button's
 * business.
 */
export function mockPublishBlock({
  tests,
  questions,
}: {
  tests: readonly MockTest[];
  questions: readonly { checked: boolean }[];
}): MockPublishBlock {
  if (tests.length === 0) return 'no-tests';
  if (questions.some((one) => !one.checked)) return 'unchecked';
  return null;
}

/** Tests in the order a student takes them. Leaves the input alone. */
export function sortTests(tests: readonly MockTest[]): MockTest[] {
  return [...tests].sort((a, b) => a.position - b.position);
}

/**
 * Validate anything into a `MockSetDraft`, or null.
 *
 * Only the three fields a teacher may set are carried over, so a `teacherId`
 * or a `status: 'live'` in the body is DROPPED right here rather than refused:
 * a caller who sends it gets a stored draft, not a hint about what we check.
 *
 * A price outside the band is REFUSED, not clamped. Clamping would charge a
 * student a price the teacher never chose.
 */
export function readSetDraft(body: unknown): MockSetDraft | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.examId !== 'string' || !UUID_RE.test(raw.examId)) return null;

  if (typeof raw.title !== 'string') return null;
  const title = raw.title.trim();
  if (title.length === 0 || title.length > MAX_SET_TITLE_LENGTH) return null;

  // Missing means "the cheapest set", which is the column default in 0015.
  let priceInr = MIN_PRICE_INR;
  if (raw.priceInr !== null && raw.priceInr !== undefined) {
    if (typeof raw.priceInr !== 'number' || !Number.isInteger(raw.priceInr)) return null;
    if (raw.priceInr < MIN_PRICE_INR || raw.priceInr > MAX_PRICE_INR) return null;
    priceInr = raw.priceInr;
  }

  return { examId: raw.examId, title, priceInr };
}

/**
 * Validate anything into a `MockTestDraft`, or null.
 *
 * `isFreeSample` fails CLOSED: anything that is not exactly `true` leaves the
 * test paid, so a half-written body can never give a test away. A `true` at
 * any position but 1 is refused outright, the same rule as
 * `mock_tests_free_sample_check`.
 */
export function readTestDraft(body: unknown): MockTestDraft | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.title !== 'string') return null;
  const title = raw.title.trim();
  if (title.length === 0 || title.length > MAX_TEST_TITLE_LENGTH) return null;

  if (typeof raw.position !== 'number' || !Number.isInteger(raw.position)) return null;
  if (raw.position < MIN_TEST_POSITION || raw.position > MAX_TEST_POSITION) return null;

  let durationMin = DEFAULT_DURATION_MIN;
  if (raw.durationMin !== null && raw.durationMin !== undefined) {
    if (typeof raw.durationMin !== 'number' || !Number.isInteger(raw.durationMin)) {
      return null;
    }
    if (raw.durationMin < MIN_DURATION_MIN || raw.durationMin > MAX_DURATION_MIN) {
      return null;
    }
    durationMin = raw.durationMin;
  }

  const isFreeSample = raw.isFreeSample === true;
  if (isFreeSample && !canBeFreeSample(raw.position)) return null;

  return { title, position: raw.position, durationMin, isFreeSample };
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface MockSetsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The CALLER'S own sets, drafts included. The id comes from the session. */
  listMine(): Promise<MockSet[]>;
  /** One teacher's LIVE sets, for a student. RLS enforces "live" as well. */
  listLiveForTeacher(teacherId: string): Promise<MockSet[]>;
  /** One set, or null. RLS decides whether the caller may see it at all. */
  readOne(setId: string): Promise<MockSet | null>;
  /** One set's tests, in position order. */
  listTests(setId: string): Promise<MockTest[]>;
  /**
   * One test by its own id, or null (issue 17-practice-mode).
   *
   * The mock player is reached by test id, so it has to get from the test to
   * its SET, and from the set to the EXAM whose marking scores the sitting
   * (F-E6). RLS decides whether the caller may see it at all.
   *
   * OPTIONAL, so every fake written for issue 15 is still a whole
   * `MockSetsClient`. Call it as `client.readTest?.(id) ?? null`.
   */
  readTest?(testId: string): Promise<MockTest | null>;
  /**
   * Store a set as a DRAFT, or update the price and title of an existing one.
   * The owner is the session user, never a field of the input. Throws an error
   * named `MockSetConflict` when that title is taken under that exam.
   */
  saveSet(edit: MockSetEdit): Promise<MockSet>;
  /**
   * Add one test to a set. Throws an error named `MockTestConflict` when that
   * position is taken.
   */
  saveTest(setId: string, draft: MockTestDraft): Promise<MockTest>;
  /**
   * `publish_mock_set()`. Returns how many questions went live. Throws an
   * error named `PublishEmpty`, `PublishUnchecked` or `PublishForbidden`.
   */
  publishSet(setId: string): Promise<number>;
  /**
   * The caller's own `teachers.revenue_share_pct` (X3). Falls back to 50, the
   * column default, so the estimate line always has a number to show.
   */
  readMyShare(): Promise<number>;
}

/** Browser side: the authoring screens. Calls our own routes, holds no key. */
export interface BrowserMockSetsClient {
  saveSet(edit: MockSetEdit): Promise<MockSet>;
  saveTest(setId: string, draft: MockTestDraft): Promise<MockTest>;
  /** Returns how many questions went live. */
  publish(setId: string): Promise<number>;
}
