/**
 * The server-side TeachersClient over Supabase REST (issue 05-teacher-invite-approval).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values. Every call carries the SIGNED-IN USER'S own
 * access token, so Postgres RLS is the gate.
 *
 * The privacy test here is `listPublic`: it must read the VIEW
 * (`teachers_public`), never the table, and it must never map a real name.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseTeachersClient } from '../supabase-teachers-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'caller.access.token';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const TEACHER = '44444444-4444-4444-8444-444444444444';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 200, body: null };
    return new Response(next.body === null ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseTeachersClient({ accessToken: ACCESS_TOKEN, env, fetchImpl });
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('isConfigured', () => {
  it('is false with no env, so a page can say "not set up" instead of crashing', () => {
    const { fn } = fakeFetch();
    expect(client(fn, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily: creating the client never touches the network', () => {
    const { fn, calls } = fakeFetch();
    client(fn, {});
    expect(calls).toHaveLength(0);
  });
});

describe('redeemInvite', () => {
  it('calls the SQL function, where single use is enforced', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: null }]);
    await client(fn).redeemInvite('INVITE-ONE');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proj.supabase.test/rest/v1/rpc/redeem_teacher_invite');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'INVITE-ONE' });
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
    expect(headers(calls[0]).apikey).toBe('test-anon-key');
  });

  it('throws on a used or unknown code, and quotes no response body', async () => {
    const { fn } = fakeFetch([{ status: 400, body: { message: 'invite code is not valid' } }]);
    const error = await client(fn)
      .redeemInvite('USED')
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(String(error)).toContain('400');
    expect(String(error)).not.toContain('invite code is not valid');
  });

  it('refuses an empty code without calling out', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).redeemInvite('   ')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('myStatus', () => {
  it('reads the caller own row and returns the status', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [{ status: 'approved' }] }]);
    expect(await client(fn).myStatus()).toBe('approved');
    expect(calls[0].url).toBe('https://proj.supabase.test/rest/v1/teachers?select=status');
  });

  it('returns null when there is no teacher row or the read fails', async () => {
    expect(await client(fakeFetch([{ status: 200, body: [] }]).fn).myStatus()).toBeNull();
    expect(await client(fakeFetch([{ status: 401, body: {} }]).fn).myStatus()).toBeNull();
  });

  it('returns null for a status we do not know, so the app fails closed', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [{ status: 'banned' }] }]);
    expect(await client(fn).myStatus()).toBeNull();
  });
});

describe('listPending', () => {
  it('asks only for pending rows and maps them', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: [
          {
            user_id: TEACHER,
            real_name: 'Rahul Sharma',
            alias: 'Polity Guru',
            created_at: '2026-11-05T10:00:00Z',
          },
        ],
      },
    ]);

    const rows = await client(fn).listPending();

    expect(calls[0].url).toContain('/rest/v1/teachers?');
    expect(calls[0].url).toContain('status=eq.pending');
    expect(rows).toEqual([
      {
        userId: TEACHER,
        realName: 'Rahul Sharma',
        alias: 'Polity Guru',
        createdAt: '2026-11-05T10:00:00Z',
      },
    ]);
  });

  it('returns an empty list on any failure, so an admin page still renders', async () => {
    expect(await client(fakeFetch([{ status: 403, body: {} }]).fn).listPending()).toEqual([]);
    expect(await client(fakeFetch([{ status: 200, body: { oops: true } }]).fn).listPending()).toEqual(
      [],
    );
  });

  it('skips a row with no user id', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [{ real_name: 'No id' }] }]);
    expect(await client(fn).listPending()).toEqual([]);
  });
});

describe('approve', () => {
  it('patches one row to approved and stamps the admin', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);
    await client(fn).approve({ userId: TEACHER, approvedBy: ADMIN });

    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url).toContain('user_id=eq.' + TEACHER);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      status: 'approved',
      approved_by: ADMIN,
    });
  });

  it('throws with the status only when Postgres refuses', async () => {
    const { fn } = fakeFetch([{ status: 403, body: { message: 'policy teachers_admin_all' } }]);
    await expect(client(fn).approve({ userId: TEACHER, approvedBy: ADMIN })).rejects.toThrow(/403/);
  });

  it('refuses a user id that is not a uuid without calling out', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).approve({ userId: 'nope', approvedBy: ADMIN })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('listPublic: the v0 privacy rule at the app layer', () => {
  it('reads the teachers_public VIEW, never the teachers table', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    await client(fn).listPublic();

    expect(calls[0].url).toContain('/rest/v1/teachers_public');
    expect(calls[0].url).not.toContain('/rest/v1/teachers?');
    // Asking for the hidden columns is how a leak would start.
    expect(calls[0].url).not.toContain('real_name');
    expect(calls[0].url).not.toContain('photo_path');
  });

  it('maps the alias row with no real name anywhere in the result', async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: [
          {
            user_id: TEACHER,
            identity_mode: 'alias',
            display_name: 'Polity Guru',
            avatar_path: 'avatars/owl.png',
            bio_en: 'Teaches polity',
            bio_hi: 'राजनीति पढ़ाते हैं',
            videos_visible: true,
          },
        ],
      },
    ]);

    const rows = await client(fn).listPublic();

    expect(rows).toEqual([
      {
        userId: TEACHER,
        identityMode: 'alias',
        displayName: 'Polity Guru',
        avatarPath: 'avatars/owl.png',
        bioEn: 'Teaches polity',
        bioHi: 'राजनीति पढ़ाते हैं',
        videosVisible: true,
      },
    ]);
    expect(Object.keys(rows[0])).not.toContain('realName');
  });

  it('drops a row the view somehow returned with no display name', async () => {
    const { fn } = fakeFetch([
      { status: 200, body: [{ user_id: TEACHER, identity_mode: 'alias', display_name: null }] },
    ]);
    expect(await client(fn).listPublic()).toEqual([]);
  });

  it('returns an empty list on any failure', async () => {
    expect(await client(fakeFetch([{ status: 500, body: {} }]).fn).listPublic()).toEqual([]);
  });
});

/**
 * readPublic / listPublicByIds: the portfolio page and the Home tab
 * (issue 06-portfolio-follow). Both read the VIEW, never the table, so a
 * pending teacher and an alias real name stay invisible.
 */
describe('readPublic', () => {
  const ROW = {
    user_id: TEACHER,
    identity_mode: 'alias',
    display_name: 'Polity Guru',
    avatar_path: null,
    bio_en: null,
    bio_hi: null,
    videos_visible: true,
  };

  it('reads one row of the view by id', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [ROW] }]);

    const row = await client(fn).readPublic(TEACHER);

    expect(row?.displayName).toBe('Polity Guru');
    expect(Object.keys(row ?? {})).not.toContain('realName');
    expect(calls[0].url).toContain('/rest/v1/teachers_public?select=');
    expect(calls[0].url).toContain(`user_id=eq.${TEACHER}`);
    expect(calls[0].url).not.toContain('real_name');
  });

  it('is null for a teacher the view does not return (pending, or gone)', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [] }]);
    expect(await client(fn).readPublic(TEACHER)).toBeNull();
  });

  it('is null, and makes no call, for an id that is not a uuid', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn).readPublic('../../rest/v1/teachers')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null on any failure', async () => {
    const { fn } = fakeFetch([{ status: 500, body: {} }]);
    expect(await client(fn).readPublic(TEACHER)).toBeNull();
  });
});

describe('listPublicByIds', () => {
  it('asks for just those ids', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);

    await client(fn).listPublicByIds([TEACHER, ADMIN]);

    expect(calls[0].url).toContain(`user_id=in.(${TEACHER},${ADMIN})`);
  });

  it('makes no call for an empty list', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn).listPublicByIds([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('drops an id that is not a uuid instead of putting it in the URL', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);

    await client(fn).listPublicByIds(['nope', TEACHER]);

    expect(calls[0].url).toContain(`user_id=in.(${TEACHER})`);
    expect(calls[0].url).not.toContain('nope');
  });
});

/**
 * listCards / readCard: the Teachers list with the exam filter and the
 * free-sample badge (issue 67a-teachers-reader-filter).
 *
 * Both read the VIEW `teacher_cards`, which is `teachers_public` plus two
 * computed columns, so the privacy rule of `listPublic` is inherited: there is
 * no `real_name` column to ask for, and a pending teacher is not in the view.
 *
 * The badge itself is decided in SQL (0050), not here. What these tests pin
 * down is the request the reader makes and the ORDER it promises the page:
 * free sample first, then A to Z.
 */
describe('listCards', () => {
  const FREE = {
    user_id: TEACHER,
    identity_mode: 'public',
    display_name: 'Zoya Khan',
    avatar_path: null,
    bio_en: null,
    bio_hi: null,
    videos_visible: true,
    has_free_sample: true,
  };
  const PAID = { ...FREE, user_id: ADMIN, display_name: 'Amit Rao', has_free_sample: false };
  const ALSO_FREE = {
    ...FREE,
    user_id: '55555555-5555-4555-8555-555555555555',
    display_name: 'Bina Das',
    has_free_sample: true,
  };

  const NET = 'a4000001-0000-4000-8000-000000000001';
  const CUET = 'a4000001-0000-4000-8000-000000000002';

  it('reads the teacher_cards VIEW, never the teachers table, and asks for no real name', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    await client(fn).listCards();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/teacher_cards?select=');
    expect(calls[0].url).not.toContain('/rest/v1/teachers?');
    expect(calls[0].url).toContain('has_free_sample');
    expect(calls[0].url).not.toContain('real_name');
    expect(calls[0].url).not.toContain('photo_path');
  });

  it('filter OFF: no exam filter in the URL, so every approved teacher comes back', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    await client(fn).listCards();

    expect(calls[0].url).not.toContain('exam_ids');
  });

  it('filter ON: one overlap filter for the whole list, never one call per teacher', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    await client(fn).listCards({ examIds: [NET, CUET] });

    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain(`exam_ids=ov.{${NET},${CUET}}`);
  });

  it('drops an exam id that is not a uuid instead of putting it in the URL', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    await client(fn).listCards({ examIds: ['nope', NET] });

    expect(decodeURIComponent(calls[0].url)).toContain(`exam_ids=ov.{${NET}}`);
    expect(calls[0].url).not.toContain('nope');
  });

  it('fails CLOSED: an asked-for filter with no usable id lists nobody, and calls nothing', async () => {
    const { fn, calls } = fakeFetch();

    expect(await client(fn).listCards({ examIds: [] })).toEqual([]);
    expect(await client(fn).listCards({ examIds: ['nope'] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('orders free sample first, then A to Z, whatever order the rows arrive in', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [PAID, FREE, ALSO_FREE] }]);

    const rows = await client(fn).listCards();

    expect(rows.map((row) => row.displayName)).toEqual(['Bina Das', 'Zoya Khan', 'Amit Rao']);
    // The database is asked for the same order, so the sort is free on a long list.
    expect(calls[0].url).toContain('order=has_free_sample.desc,display_name.asc');
  });

  it('maps the badge and still carries no real name', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [FREE, PAID] }]);

    const rows = await client(fn).listCards();

    expect(rows[0]).toEqual({
      userId: TEACHER,
      identityMode: 'public',
      displayName: 'Zoya Khan',
      avatarPath: null,
      bioEn: null,
      bioHi: null,
      videosVisible: true,
      hasFreeSample: true,
    });
    expect(rows[1].hasFreeSample).toBe(false);
    expect(Object.keys(rows[0])).not.toContain('realName');
  });

  it('reads a missing or odd has_free_sample as NO badge, never as one', async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: [
          { ...FREE, has_free_sample: undefined },
          { ...PAID, has_free_sample: 'true' },
        ],
      },
    ]);

    const rows = await client(fn).listCards();

    expect(rows.map((row) => row.hasFreeSample)).toEqual([false, false]);
  });

  it('drops a row the view somehow returned with no display name', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [{ ...FREE, display_name: null }] }]);
    expect(await client(fn).listCards()).toEqual([]);
  });

  it('returns an empty list on any failure, so the page still renders', async () => {
    const { fn } = fakeFetch([{ status: 500, body: {} }]);
    expect(await client(fn).listCards()).toEqual([]);
  });
});

describe('readCard', () => {
  const ROW = {
    user_id: TEACHER,
    identity_mode: 'alias',
    display_name: 'Polity Guru',
    avatar_path: null,
    bio_en: null,
    bio_hi: null,
    videos_visible: true,
    has_free_sample: true,
  };

  it('reads one row of the view by id, with the badge', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [ROW] }]);

    const card = await client(fn).readCard(TEACHER);

    expect(card?.hasFreeSample).toBe(true);
    expect(calls[0].url).toContain('/rest/v1/teacher_cards?select=');
    expect(calls[0].url).toContain(`user_id=eq.${TEACHER}`);
    expect(calls[0].url).not.toContain('real_name');
  });

  it('is null for a teacher the view does not return (pending, or gone)', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [] }]);
    expect(await client(fn).readCard(TEACHER)).toBeNull();
  });

  it('is null, and makes no call, for an id that is not a uuid', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn).readCard('../../rest/v1/teachers')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null on any failure', async () => {
    const { fn } = fakeFetch([{ status: 500, body: {} }]);
    expect(await client(fn).readCard(TEACHER)).toBeNull();
  });
});
