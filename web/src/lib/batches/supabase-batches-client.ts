/**
 * Server-side `BatchesClient` over the Supabase REST API (issue 19-batches).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the `batch_*`
 * policies for a read or a write, and `join_batch()` for a join.
 *
 * TWO THINGS ARE NEVER IN A REQUEST BODY:
 *
 *  * `teacher_id` on a create. It comes from the session, so there is no field
 *    a caller could set to make a batch under another teacher's name.
 *  * `join_code`, ever. The column default (`new_join_code()`) owns it, and a
 *    code a caller could choose is a code they could point at a batch they
 *    want to guess.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isUuid,
  normalizeJoinCode,
  type Batch,
  type BatchEdit,
  type BatchMember,
  type BatchSetLink,
  type BatchesClient,
} from './types';

const BATCHES = '/rest/v1/batches';
const MEMBERS = '/rest/v1/batch_members';
const BATCH_SETS = '/rest/v1/batch_sets';
const JOIN = '/rest/v1/rpc/join_batch';

/** Never `select=*`, so a column added later cannot leak by accident. */
const BATCH_COLUMNS = 'id,teacher_id,name,join_code';
const MEMBER_COLUMNS = 'batch_id,user_id,joined_at';
const BATCH_SET_COLUMNS = 'batch_id,set_id';

/** One screen's worth of batches. A teacher does not run a hundred of them. */
const MAX_BATCH_IDS = 50;

export interface SupabaseBatchesClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface BatchRaw {
  id?: unknown;
  teacher_id?: unknown;
  name?: unknown;
  join_code?: unknown;
}

interface MemberRaw {
  batch_id?: unknown;
  user_id?: unknown;
  joined_at?: unknown;
}

interface BatchSetRaw {
  batch_id?: unknown;
  set_id?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One batch row, or null when any field is missing or the wrong shape. */
function readBatchRow(raw: BatchRaw): Batch | null {
  const id = text(raw?.id);
  const teacherId = text(raw?.teacher_id);
  const name = text(raw?.name);
  const joinCode = text(raw?.join_code);
  if (!id || !teacherId || !name || !joinCode) return null;
  return { id, teacherId, name, joinCode };
}

function readMemberRow(raw: MemberRaw): BatchMember | null {
  const batchId = text(raw?.batch_id);
  const userId = text(raw?.user_id);
  const joinedAt = text(raw?.joined_at);
  if (!batchId || !userId || !joinedAt) return null;
  return { batchId, userId, joinedAt };
}

function readBatchSetRow(raw: BatchSetRaw): BatchSetLink | null {
  const batchId = text(raw?.batch_id);
  const setId = text(raw?.set_id);
  if (!batchId || !setId) return null;
  return { batchId, setId };
}

export function createSupabaseBatchesClient(
  options: SupabaseBatchesClientOptions,
): BatchesClient {
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

  async function listBatches(query: string): Promise<Batch[]> {
    const raw = await rows<BatchRaw>(BATCHES, `select=${BATCH_COLUMNS}${query}`);
    const out: Batch[] = [];
    for (const one of raw) {
      // A row we cannot read is DROPPED, never half-filled: a batch shown
      // without its code is a batch nobody can join.
      const batch = readBatchRow(one);
      if (batch) out.push(batch);
    }
    return out;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listMine() {
      if (!isUuid(options.userId)) return [];
      // `teacher_id=eq.<me>` as well as the policy. Belt and braces: the
      // filter says what this read is FOR, and the policy makes it true. It
      // also keeps the batches this teacher happens to be a MEMBER of out of
      // their own management list.
      return listBatches(
        `&teacher_id=eq.${encodeURIComponent(options.userId)}&order=created_at.desc`,
      );
    },

    async readOne(batchId: string) {
      // The id goes into a URL, so it is checked against the UUID shape first.
      if (!isUuid(batchId)) return null;
      const found = await listBatches(`&id=eq.${encodeURIComponent(batchId)}&limit=1`);
      return found[0] ?? null;
    },

    async saveBatch(edit: BatchEdit) {
      const { url } = required();
      if (!isUuid(options.userId)) throw new Error('user id must be a uuid');
      if (edit.id !== null && !isUuid(edit.id)) throw new Error('batch id must be a uuid');

      const existing = edit.id;
      const target =
        existing === null
          ? `${url}${BATCHES}?select=${BATCH_COLUMNS}`
          : `${url}${BATCHES}?id=eq.${encodeURIComponent(existing)}&select=${BATCH_COLUMNS}`;

      const res = await doFetch(target, {
        method: existing === null ? 'POST' : 'PATCH',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify(
          existing === null
            ? {
                // The owner comes from the session, never from the body. No
                // `join_code`: the column default owns it.
                teacher_id: options.userId,
                name: edit.name,
              }
            : // On a rename neither the owner nor the code moves. The
              // `batches_update_own` policy would refuse a new owner anyway,
              // and not sending them means a bug here cannot try.
              { name: edit.name },
        ),
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Supabase batch save failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as BatchRaw) : (body as BatchRaw);
      const stored = readBatchRow(first ?? {});
      // An empty array from a PATCH means RLS hid the row: somebody else's
      // batch. Treated as a failure, so the screen never shows "saved".
      if (!stored) throw new Error('Supabase batch save returned no row');
      return stored;
    },

    async listMembers(batchIds: readonly string[]) {
      // An id that is not a uuid is DROPPED rather than put in a URL.
      const ids = batchIds.filter(isUuid).slice(0, MAX_BATCH_IDS);
      if (ids.length === 0) return [];

      const raw = await rows<MemberRaw>(
        MEMBERS,
        `select=${MEMBER_COLUMNS}` +
          `&batch_id=in.(${ids.map(encodeURIComponent).join(',')})` +
          '&order=joined_at.asc',
      );
      const out: BatchMember[] = [];
      for (const one of raw) {
        const member = readMemberRow(one);
        if (member) out.push(member);
      }
      return out;
    },

    async removeMember(batchId: string, userId: string) {
      const { url } = required();
      if (!isUuid(batchId)) throw new Error('batch id must be a uuid');
      if (!isUuid(userId)) throw new Error('user id must be a uuid');

      // Both filters, so one typo cannot empty a whole batch.
      const res = await doFetch(
        `${url}${MEMBERS}?batch_id=eq.${encodeURIComponent(batchId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          headers: headers({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        throw new Error('Supabase batch member remove failed with status ' + res.status);
      }
    },

    async listSets(batchId: string) {
      if (!isUuid(batchId)) return [];
      const raw = await rows<BatchSetRaw>(
        BATCH_SETS,
        `select=${BATCH_SET_COLUMNS}&batch_id=eq.${encodeURIComponent(batchId)}`,
      );
      const out: BatchSetLink[] = [];
      for (const one of raw) {
        const link = readBatchSetRow(one);
        if (link) out.push(link);
      }
      return out;
    },

    async addSet(batchId: string, setId: string) {
      const { url } = required();
      if (!isUuid(batchId)) throw new Error('batch id must be a uuid');
      if (!isUuid(setId)) throw new Error('set id must be a uuid');

      const res = await doFetch(`${url}${BATCH_SETS}`, {
        method: 'POST',
        headers: headers({
          accept: 'application/json',
          // Adding a set the batch already gives away is a double tap on a
          // slow connection, not a 409 the teacher has to read.
          prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({ batch_id: batchId, set_id: setId }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Supabase batch set add failed with status ' + res.status);
      }
    },

    async dropSet(batchId: string, setId: string) {
      const { url } = required();
      if (!isUuid(batchId)) throw new Error('batch id must be a uuid');
      if (!isUuid(setId)) throw new Error('set id must be a uuid');

      const res = await doFetch(
        `${url}${BATCH_SETS}?batch_id=eq.${encodeURIComponent(batchId)}` +
          `&set_id=eq.${encodeURIComponent(setId)}`,
        {
          method: 'DELETE',
          headers: headers({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        throw new Error('Supabase batch set drop failed with status ' + res.status);
      }
    },

    async join(code: string) {
      const { url } = required();
      const clean = normalizeJoinCode(code);
      // Checked here as well as in the route: a code that cannot exist is not
      // worth a request.
      if (!clean) throw new Error('that is not a join code');

      const res = await doFetch(`${url}${JOIN}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({ for_code: clean }),
        cache: 'no-store',
      });

      if (!res.ok) {
        // Read the CODE only. The message beside it is prose and may quote a
        // constraint name, so it never leaves this function.
        let pgCode = '';
        try {
          const body = (await res.json()) as { code?: unknown };
          if (typeof body?.code === 'string') pgCode = body.code;
        } catch {
          // No JSON body. Falls through to the generic error below.
        }

        // P0002 no_data_found: `join_batch()` found no batch with that code.
        if (pgCode === 'P0002') {
          throw Object.assign(new Error('join refused'), { name: 'JoinNotFound' });
        }
        throw new Error('Supabase join failed with status ' + res.status);
      }

      // The function returns a uuid, which PostgREST sends as a bare JSON
      // string.
      const body = (await res.json()) as unknown;
      if (isUuid(body)) return body;
      throw new Error('Supabase join returned no batch');
    },
  };
}
