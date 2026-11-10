/**
 * Server-side TeachersClient over the Supabase REST API
 * (issue 05-teacher-invite-approval).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything:
 * `teachers_select_own` for a teacher, `teachers_admin_all` for an admin, and
 * the `teachers_block_admin_fields` trigger for status and revenue share.
 * An empty access token is the ANONYMOUS caller (issue 63-public-landing):
 * the bearer is then the project anon key, so the request runs as the `anon`
 * role and reads exactly what 0005 granted it, the public view.
 *
 * PRIVACY: `listPublic` reads the VIEW `teachers_public`. Never point it at
 * `teachers`: the view is what strips the real name of an alias teacher.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isIdentityMode,
  isTeacherStatus,
  MAX_INVITE_CODE_LENGTH,
  type ApproveInput,
  type ListTeacherCardsInput,
  type PendingTeacher,
  type PublicTeacher,
  type TeacherCard,
  type TeacherStatus,
  type TeachersClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/teachers';
const VIEW = '/rest/v1/teachers_public';
/** `teachers_public` plus the badge and the exam ids (0050). */
const CARDS_VIEW = '/rest/v1/teacher_cards';
const REDEEM_RPC = '/rest/v1/rpc/redeem_teacher_invite';

/** Columns the admin screen needs. Never `select=*`, so a new column cannot leak. */
const PENDING_COLUMNS = 'user_id,real_name,alias,created_at';
const PUBLIC_COLUMNS = 'user_id,identity_mode,display_name,avatar_path,bio_en,bio_hi,videos_visible';
/**
 * The card columns. `exam_ids` is deliberately NOT asked for: it is what the
 * filter runs on in Postgres, and no screen shows it, so it stays out of the
 * response.
 */
const CARD_COLUMNS = `${PUBLIC_COLUMNS},has_free_sample`;

/**
 * Free sample first, then A to Z. Postgres sorts booleans false < true, so
 * `desc` puts the badge on top. `sortCards` repeats this in JavaScript and is
 * the real guarantee; this parameter just lets the index do the work.
 */
const CARD_ORDER = 'order=has_free_sample.desc,display_name.asc';

export interface SupabaseTeachersClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface PendingRow {
  user_id?: unknown;
  real_name?: unknown;
  alias?: unknown;
  created_at?: unknown;
}

interface PublicRow {
  user_id?: unknown;
  identity_mode?: unknown;
  display_name?: unknown;
  avatar_path?: unknown;
  bio_en?: unknown;
  bio_hi?: unknown;
  videos_visible?: unknown;
}

interface CardRow extends PublicRow {
  has_free_sample?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createSupabaseTeachersClient(
  options: SupabaseTeachersClientOptions,
): TeachersClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /**
   * Same headers on every call: the project key plus the caller's token.
   *
   * An EMPTY access token means there is no signed-in caller: the logged-out
   * landing and a shared `/t/<id>` link (issue 63-public-landing). The bearer
   * then falls back to the project anon key, so Postgres runs the request as
   * the `anon` role and 0005's grants decide: select on `teachers_public`
   * yes, `public.teachers` no (no policy covers `anon`). A bare `Bearer `
   * with nothing after it is a malformed JWT and Supabase answers 401, which
   * a page would read as "no such teacher".
   */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + (options.accessToken || anonKey),
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** GET a list of rows. Any failure is an empty list, never a crash. */
  async function readRows(path: string): Promise<unknown[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(found.url + path, {
      method: 'GET',
      headers: restHeaders({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body : [];
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async redeemInvite(code: string) {
      const trimmed = code.trim();
      if (!trimmed || trimmed.length > MAX_INVITE_CODE_LENGTH) {
        throw new Error('invite code is missing or too long');
      }

      const { url } = required();
      const res = await doFetch(url + REDEEM_RPC, {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({ code: trimmed }),
        cache: 'no-store',
      });
      // A used or unknown code raises inside the SQL function, which comes
      // back as a 4xx. The status only: the body quotes Postgres.
      if (!res.ok) throw new Error('Supabase redeem failed with status ' + res.status);
    },

    async myStatus(): Promise<TeacherStatus | null> {
      const rows = await readRows(TABLE + '?select=status');
      const first = rows[0] as { status?: unknown } | undefined;
      // Fail closed: a status we do not know is not "approved".
      return isTeacherStatus(first?.status) ? first.status : null;
    },

    async listPending() {
      const rows = await readRows(
        `${TABLE}?select=${PENDING_COLUMNS}&status=eq.pending&order=created_at.asc`,
      );

      const out: PendingTeacher[] = [];
      for (const raw of rows as PendingRow[]) {
        const userId = text(raw.user_id);
        if (userId === null) continue;
        out.push({
          userId,
          realName: text(raw.real_name),
          alias: text(raw.alias),
          createdAt: text(raw.created_at) ?? '',
        });
      }
      return out;
    },

    async approve({ userId, approvedBy }: ApproveInput) {
      if (!UUID_RE.test(userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(approvedBy)) throw new Error('approver id must be a uuid');

      const { url } = required();
      const res = await doFetch(`${url}${TABLE}?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: restHeaders({ prefer: 'return=minimal' }),
        body: JSON.stringify({ status: 'approved', approved_by: approvedBy }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Supabase approve failed with status ' + res.status);
    },

    async listPublic() {
      const rows = await readRows(`${VIEW}?select=${PUBLIC_COLUMNS}&order=display_name.asc`);
      return mapPublic(rows);
    },

    async readPublic(userId: string) {
      // Checked before it goes into the URL, so a crafted id cannot steer the
      // request at another path. An invalid id is "no such teacher", not a
      // crash: the page then renders its not-found state.
      if (!UUID_RE.test(userId)) return null;

      const rows = await readRows(
        `${VIEW}?select=${PUBLIC_COLUMNS}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      );
      return mapPublic(rows)[0] ?? null;
    },

    async listPublicByIds(userIds: readonly string[]) {
      const ids = userIds.filter((id) => UUID_RE.test(id));
      if (ids.length === 0) return [];

      const inList = ids.map((id) => encodeURIComponent(id)).join(',');
      const rows = await readRows(
        `${VIEW}?select=${PUBLIC_COLUMNS}&user_id=in.(${inList})&order=display_name.asc`,
      );
      return mapPublic(rows);
    },

    async listCards(input: ListTeacherCardsInput = {}) {
      const query = [`select=${CARD_COLUMNS}`, CARD_ORDER];

      if (input.examIds !== undefined) {
        // Checked before they go into the URL, the same rule as every other id
        // here: a crafted value cannot steer the request at another path.
        const examIds = input.examIds.filter((id) => UUID_RE.test(id));
        // Fails CLOSED. "Filter by these exams" with no usable exam is an
        // empty list, never the whole list: see ListTeacherCardsInput.
        if (examIds.length === 0) return [];
        query.push(`exam_ids=ov.{${examIds.join(',')}}`);
      }

      const rows = await readRows(`${CARDS_VIEW}?${query.join('&')}`);
      return sortCards(mapCards(rows));
    },

    async readCard(userId: string) {
      if (!UUID_RE.test(userId)) return null;

      const rows = await readRows(
        `${CARDS_VIEW}?select=${CARD_COLUMNS}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      );
      return mapCards(rows)[0] ?? null;
    },
  };
}

/**
 * ONE row of `teachers_public` (or of `teacher_cards`, which repeats its
 * columns) to `PublicTeacher`, or null when the row is unusable.
 *
 * One place, so `listPublic`, `readPublic`, `listPublicByIds`, `listCards` and
 * `readCard` cannot drift apart and start mapping a different set of columns.
 */
function mapPublicRow(raw: PublicRow): PublicTeacher | null {
  const userId = text(raw.user_id);
  const displayName = text(raw.display_name);
  // A teacher with no name to show is not shown at all. Better a short list
  // than a row that leans on a fallback and leaks something.
  if (userId === null || displayName === null || !isIdentityMode(raw.identity_mode)) return null;
  return {
    userId,
    identityMode: raw.identity_mode,
    displayName,
    avatarPath: text(raw.avatar_path),
    bioEn: text(raw.bio_en),
    bioHi: text(raw.bio_hi),
    videosVisible: raw.videos_visible !== false,
  };
}

function mapPublic(rows: unknown[]): PublicTeacher[] {
  const out: PublicTeacher[] = [];
  for (const raw of rows as PublicRow[]) {
    const mapped = mapPublicRow(raw);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

/**
 * Rows of `teacher_cards` to `TeacherCard`.
 *
 * The badge is `=== true` and nothing looser. A missing column or the STRING
 * `"true"` is NO badge: the one wrong answer that matters here is telling a
 * student a test is free when it is not.
 */
function mapCards(rows: unknown[]): TeacherCard[] {
  const out: TeacherCard[] = [];
  for (const raw of rows as CardRow[]) {
    const mapped = mapPublicRow(raw);
    if (mapped !== null) out.push({ ...mapped, hasFreeSample: raw.has_free_sample === true });
  }
  return out;
}

/**
 * Free sample first, then A to Z.
 *
 * The request already asks Postgres for this order, so why sort again? Because
 * the order is a PROMISE to the page, and a dropped `order` parameter or a new
 * caller that forgets it would silently change what the student sees. Sorting
 * a list of tens of teachers costs nothing, and makes the promise true in one
 * place instead of in every URL.
 */
function sortCards(cards: TeacherCard[]): TeacherCard[] {
  return cards.sort((a, b) => {
    if (a.hasFreeSample !== b.hasFreeSample) return a.hasFreeSample ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, 'en');
  });
}
