/**
 * The batch contract (issue 19-batches).
 *
 * design.md V2 and V3: a teacher makes many batches, a student can be in many
 * of them, they join by link or code, and the teacher picks which of their own
 * mock sets the batch gets free.
 *
 * Nothing in this file is permission. The gate is `0019_batches.sql`:
 * `join_batch()` is the only writer of `batch_members`, the `batch_*` policies
 * decide every read, and triggers keep the `set_access` rows with
 * `source = 'batch'` in step. A student who edits the JSON still reads zero
 * locked questions, because Postgres decides.
 *
 * Supabase sits behind the interfaces at the bottom, so tests fake them: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 *  * `BatchesClient`        -- server side, carries the caller's own access
 *                             token, so the `batch_*` policies decide.
 *  * `BrowserBatchesClient` -- the screens. They post to our own routes and
 *                             never see a key.
 *
 * NOT HERE: batch reports and scores (F-B4) are issue 20.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `new_join_code()` in 0019 generates. */
export const JOIN_CODE_LENGTH = 6;

/** `batches_name_check`: one line on a 360 px phone. */
export const MAX_BATCH_NAME_LENGTH = 60;

/**
 * `batches_join_code_check`, spelled the same way.
 *
 * No O, 0, I or 1: a code is read off one phone and typed into another, so a
 * pair that looks the same in a condensed font is a support ticket. A code
 * that contains one of them was mistyped, and saying so here saves a round
 * trip that would come back "no such batch".
 */
const JOIN_CODE_RE = /^[A-HJ-NP-Z2-9]{6,12}$/;

/** One batch, as the app passes it around. */
export interface Batch {
  id: string;
  teacherId: string;
  name: string;
  /** What a student types or taps. Upper-case, unique across the app. */
  joinCode: string;
}

/** One row of the teacher's batch list: the batch plus how many are in it. */
export interface BatchRow extends Batch {
  studentCount: number;
}

/** One membership. There is no name: v1 reads no other user's profile. */
export interface BatchMember {
  batchId: string;
  userId: string;
  /** ISO timestamp. */
  joinedAt: string;
}

/** One set a batch gives away free (V3). */
export interface BatchSetLink {
  batchId: string;
  setId: string;
}

/** Creating or renaming. The owner is never here: it comes from the session. */
export interface BatchEdit {
  /** Null for a new batch. */
  id: string | null;
  name: string;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The code a student typed, or null when it cannot be a join code at all.
 *
 * Case and the separators a pasted code arrives with are forgiven: the code
 * comes by WhatsApp and gets typed with a space on the end. `join_batch()`
 * upper-cases and trims on its side too, so the two agree.
 */
export function normalizeJoinCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\s-]+/g, '').toUpperCase();
  return JOIN_CODE_RE.test(clean) ? clean : null;
}

/** The page a join link points at. V2: "Student joins by link or code". */
export function joinPath(code: string): string {
  const clean = normalizeJoinCode(code) ?? '';
  return '/join/' + encodeURIComponent(clean);
}

/**
 * The whole link a teacher copies into WhatsApp.
 *
 * An empty origin gives the path on its own, because the server's first paint
 * has no `window.location` and a link reading "undefined/join/ABC234" is worse
 * than a relative one.
 */
export function joinLink(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, '');
  return base + joinPath(code);
}

/** The teacher's own page for one batch. */
export function batchPath(batchId: string): string {
  return '/teacher/batches/' + encodeURIComponent(batchId);
}

/**
 * The name out of a request body, or null.
 *
 * Trimmed and length-checked here as well as by `batches_name_check`, so a
 * teacher who left the field blank gets a line with no round trip.
 */
export function readBatchName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>).name;
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (clean.length === 0 || clean.length > MAX_BATCH_NAME_LENGTH) return null;
  return clean;
}

/** How many students are in each batch, for the list screen. */
export function countMembers(members: readonly BatchMember[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const one of members) {
    counts.set(one.batchId, (counts.get(one.batchId) ?? 0) + 1);
  }
  return counts;
}

/** The set ids one batch gives away free. */
export function setsOfBatch(
  links: readonly BatchSetLink[],
  batchId: string,
): string[] {
  return links.filter((one) => one.batchId === batchId).map((one) => one.setId);
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface BatchesClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The caller's own batches, newest first. */
  listMine(): Promise<Batch[]>;
  /**
   * One batch, or null.
   *
   * Null is what a stranger gets AND what a teacher gets for somebody else's
   * batch, because RLS hid the row. The screen says "Batch not found" for
   * both, so it never tells anybody that a batch exists but is not theirs.
   */
  readOne(batchId: string): Promise<Batch | null>;
  /** Create (`id: null`) or rename. The owner comes from the session. */
  saveBatch(edit: BatchEdit): Promise<Batch>;
  /** The roll of one or several batches. The teacher's own only. */
  listMembers(batchIds: readonly string[]): Promise<BatchMember[]>;
  /** V2: the teacher removes a student. The trigger revokes the sets. */
  removeMember(batchId: string, userId: string): Promise<void>;
  /** Which sets this batch gives away free (V3). */
  listSets(batchId: string): Promise<BatchSetLink[]>;
  addSet(batchId: string, setId: string): Promise<void>;
  dropSet(batchId: string, setId: string): Promise<void>;
  /**
   * Trade a join code for a membership. Returns the batch id.
   *
   * Throws an error NAMED `JoinNotFound` when no batch has that code, so the
   * route can answer 404 without reading a Postgres message.
   */
  join(code: string): Promise<string>;
}

/** Browser side. Calls our own routes; never sees a Supabase key. */
export interface BrowserBatchesClient {
  saveBatch(edit: BatchEdit): Promise<Batch>;
  removeMember(batchId: string, userId: string): Promise<void>;
  /** One toggle: `free` true adds the set to the batch, false drops it. */
  setFree(batchId: string, setId: string, free: boolean): Promise<void>;
  join(code: string): Promise<string>;
}
