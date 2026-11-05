/**
 * The decision logic behind the three mock set routes
 * (issue 15-mock-sets-authoring).
 *
 * The rules this file pins:
 *
 *  * nobody signed in -> 401; a student -> 403; no keys -> 503.
 *  * a price outside Rs 299 to Rs 399 -> 400, never a clamped sale.
 *  * a `teacherId` or a `status` in the body is DROPPED, so a caller cannot
 *    own or publish a set by asking.
 *  * a free sample at any position but 1 -> 400 (V11).
 *  * every publish refusal comes from `publish_mock_set()`, not from a count
 *    done here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import {
  handlePublishMockSet,
  handleSaveMockSet,
  handleSaveMockTest,
} from '../mocks-route';
import type { MockSet, MockSetsClient, MockTest } from '../types';

const EXAM = 'a4000001-0000-4000-8000-000000000001';
const SET = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'caller-token',
    refreshToken: 'refresh',
    userId: TEACHER,
    role: 'teacher',
    teacherStatus: 'approved',
    ...over,
  };
}

const STORED_SET: MockSet = {
  id: SET,
  teacherId: TEACHER,
  examId: EXAM,
  title: 'Full length set 1',
  priceInr: 349,
  status: 'draft',
};

const STORED_TEST: MockTest = {
  id: TEST,
  setId: SET,
  title: 'Test 1',
  position: 1,
  durationMin: 120,
  isFreeSample: true,
};

/** A fake client. No network call and no key anywhere (web/CLAUDE.md). */
function client(over: Partial<MockSetsClient> = {}): MockSetsClient {
  return {
    isConfigured: () => true,
    listMine: async () => [],
    listLiveForTeacher: async () => [],
    readOne: async () => null,
    listTests: async () => [],
    saveSet: async () => STORED_SET,
    saveTest: async () => STORED_TEST,
    publishSet: async () => 0,
    readMyShare: async () => 50,
    ...over,
  };
}

const SET_BODY = { examId: EXAM, title: 'Full length set 1', priceInr: 349 };
const TEST_BODY = { title: 'Test 1', position: 1, durationMin: 120, isFreeSample: true };

describe('handleSaveMockSet', () => {
  it('turns away a caller with no session', async () => {
    const saveSet = vi.fn();
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: null,
      client: client({ saveSet }),
    });

    expect(reply.status).toBe(401);
    expect(saveSet).not.toHaveBeenCalled();
  });

  it('turns away a student: a set belongs to a teacher', async () => {
    const saveSet = vi.fn();
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: session({ role: 'student' }),
      client: client({ saveSet }),
    });

    expect(reply.status).toBe(403);
    expect(saveSet).not.toHaveBeenCalled();
  });

  it('says not configured, rather than crashing, with no keys', async () => {
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: session(),
      client: client({ isConfigured: () => false }),
    });
    expect(reply.status).toBe(503);
  });

  it('stores a good set and hands the stored row back', async () => {
    const saveSet = vi.fn(async () => STORED_SET);
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: session(),
      client: client({ saveSet }),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, set: STORED_SET });
    expect(saveSet).toHaveBeenCalledWith({
      id: null,
      examId: EXAM,
      title: 'Full length set 1',
      priceInr: 349,
    });
  });

  it('refuses Rs 298 and Rs 400, and never calls the client (V11)', async () => {
    for (const priceInr of [298, 400]) {
      const saveSet = vi.fn();
      const reply = await handleSaveMockSet({
        body: { ...SET_BODY, priceInr },
        session: session(),
        client: client({ saveSet }),
      });

      expect(reply.status).toBe(400);
      expect(saveSet).not.toHaveBeenCalled();
    }
  });

  it('drops a teacherId and a status out of the body', async () => {
    const saveSet = vi.fn(async () => STORED_SET);
    await handleSaveMockSet({
      body: { ...SET_BODY, teacherId: 'somebody-else', status: 'live' },
      session: session(),
      client: client({ saveSet }),
    });

    const [edit] = saveSet.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(edit).not.toHaveProperty('teacherId');
    expect(edit).not.toHaveProperty('status');
  });

  it('carries an existing set id through, so a price edit patches', async () => {
    const saveSet = vi.fn(async () => STORED_SET);
    await handleSaveMockSet({
      body: { ...SET_BODY, id: SET },
      session: session(),
      client: client({ saveSet }),
    });

    const [edit] = saveSet.mock.calls[0] as unknown as [{ id: string | null }];
    expect(edit.id).toBe(SET);
  });

  it('refuses a set id that is not a uuid', async () => {
    const reply = await handleSaveMockSet({
      body: { ...SET_BODY, id: 'set-1' },
      session: session(),
      client: client(),
    });
    expect(reply.status).toBe(400);
  });

  it('answers 409 for a title the teacher already used', async () => {
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: session(),
      client: client({
        saveSet: async () => {
          throw Object.assign(new Error('taken'), { name: 'MockSetConflict' });
        },
      }),
    });

    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: 'duplicate' });
  });

  it('answers 502 with a fixed word when Supabase says no', async () => {
    const reply = await handleSaveMockSet({
      body: SET_BODY,
      session: session(),
      client: client({
        saveSet: async () => {
          throw new Error('policy "mock_sets_insert_own" blocked this');
        },
      }),
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});

describe('handleSaveMockTest', () => {
  it('turns away a student before it looks at the body', async () => {
    const saveTest = vi.fn();
    const reply = await handleSaveMockTest({
      setId: SET,
      body: TEST_BODY,
      session: session({ role: 'student' }),
      client: client({ saveTest }),
    });

    expect(reply.status).toBe(403);
    expect(saveTest).not.toHaveBeenCalled();
  });

  it('stores Test 1 as the free sample', async () => {
    const saveTest = vi.fn(async () => STORED_TEST);
    const reply = await handleSaveMockTest({
      setId: SET,
      body: TEST_BODY,
      session: session(),
      client: client({ saveTest }),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, test: STORED_TEST });
    expect(saveTest).toHaveBeenCalledWith(SET, {
      title: 'Test 1',
      position: 1,
      durationMin: 120,
      isFreeSample: true,
    });
  });

  it('refuses a free sample at position 2 (V11)', async () => {
    const saveTest = vi.fn();
    const reply = await handleSaveMockTest({
      setId: SET,
      body: { ...TEST_BODY, position: 2 },
      session: session(),
      client: client({ saveTest }),
    });

    expect(reply.status).toBe(400);
    expect(saveTest).not.toHaveBeenCalled();
  });

  it('refuses a set id that is not a uuid, before building a URL', async () => {
    const saveTest = vi.fn();
    const reply = await handleSaveMockTest({
      setId: 'set-1',
      body: TEST_BODY,
      session: session(),
      client: client({ saveTest }),
    });

    expect(reply.status).toBe(400);
    expect(saveTest).not.toHaveBeenCalled();
  });

  it('answers 409 for a position that is taken', async () => {
    const reply = await handleSaveMockTest({
      setId: SET,
      body: TEST_BODY,
      session: session(),
      client: client({
        saveTest: async () => {
          throw Object.assign(new Error('taken'), { name: 'MockTestConflict' });
        },
      }),
    });

    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: 'duplicate position' });
  });
});

describe('handlePublishMockSet', () => {
  it('publishes and reports how many questions went live', async () => {
    const reply = await handlePublishMockSet({
      setId: SET,
      session: session(),
      client: client({ publishSet: async () => 40 }),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, published: 40 });
  });

  it('passes every refusal of publish_mock_set() straight through', async () => {
    const cases = [
      ['PublishUnchecked', 409, 'unchecked'],
      ['PublishEmpty', 409, 'no tests'],
      ['PublishForbidden', 404, 'not found'],
    ] as const;

    for (const [name, status, error] of cases) {
      const reply = await handlePublishMockSet({
        setId: SET,
        session: session(),
        client: client({
          publishSet: async () => {
            throw Object.assign(new Error('nope'), { name });
          },
        }),
      });

      expect(reply.status).toBe(status);
      expect(reply.body).toEqual({ error });
    }
  });

  it('answers 502 with a fixed word for anything else', async () => {
    const reply = await handlePublishMockSet({
      setId: SET,
      session: session(),
      client: client({
        publishSet: async () => {
          throw new Error('relation "mock_sets" does not exist');
        },
      }),
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'publish failed' });
  });

  it('refuses a set id that is not a uuid, and never calls the client', async () => {
    const publishSet = vi.fn();
    const reply = await handlePublishMockSet({
      setId: 'set-1',
      session: session(),
      client: client({ publishSet }),
    });

    expect(reply.status).toBe(400);
    expect(publishSet).not.toHaveBeenCalled();
  });

  it('turns away a caller with no session', async () => {
    const reply = await handlePublishMockSet({
      setId: SET,
      session: null,
      client: client(),
    });
    expect(reply.status).toBe(401);
  });
});
