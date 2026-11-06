/**
 * POST /api/revision, the decision logic (issue 22-revision-api).
 *
 * The six things the issue asks for, with a FAKE explainer. No real network
 * call and no real key (web/CLAUDE.md):
 *
 *  1. no plan              -> refused, and the model is never called.
 *  2. a saved explanation  -> returned at once, count unchanged, no call.
 *  3. the 31st new one     -> refused with the code `limit`.
 *  4. two calls at once    -> the explainer runs ONCE.
 *  5. the model fails      -> the count goes back, and it says so.
 *  6. over 10 a minute     -> refused before anything else happens.
 *
 * The fake `AiClient` below is backed by a Map and copies the SQL semantics
 * of `claim_ai_explanation()`. `test/ai.test.ts` is what proves those
 * semantics in real Postgres; this file proves the route obeys them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleRevision } from '../revision-route';
import { createRateLimiter } from '../rate-limit';
import {
  AI_DAILY_CAP,
  type AiClient,
  type ClaimCode,
  type ExplainResult,
  type Explainer,
  type Explanation,
  type QuestionForExplain,
  type RevisionRequest,
} from '../types';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';

function session(userId = STUDENT): AuthSession {
  return { accessToken: 'token', refreshToken: 'r', userId, role: 'student' };
}

const QUESTION_ROW: QuestionForExplain = {
  exam: 'UGC NET',
  topic: 'Parliament',
  stem: 'Which house is the Council of States?',
  options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
  correctIdx: 1,
  teacherExplanation: 'Article 80.',
};

const RESULT: ExplainResult = {
  body: {
    exam: 'UGC NET',
    topic: 'Parliament',
    question: 'Council of States',
    sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
    remember: 'Rajya Sabha = Council of States.',
  },
  sources: [{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }],
  model: 'claude-haiku-5-5',
  tokensIn: 900,
  tokensOut: 450,
  searches: 2,
};

interface FakeOptions {
  /** Does the student hold the AI plan or Pro? */
  plan?: boolean;
  /** How many NEW explanations they have had today. */
  used?: number;
  configured?: boolean;
  question?: QuestionForExplain | null;
}

/**
 * A fake database with the same decision order as `claim_ai_explanation()`:
 * plan, saved lookup, 30-a-day, then the primary key that decides the race.
 *
 * It also copies the CLAIM SECRET rule (issue 37-ai-claim-secret): a claim
 * hands back a fresh secret, and `finish` / `fail` do nothing at all without
 * the matching one. So a route that forgets to pass it down fails here, the
 * same way it would fail against real Postgres.
 */
function fakeClient(options: FakeOptions = {}) {
  const plan = options.plan ?? true;
  const rows = new Map<string, Explanation>();
  /** Postgres stores a sha256; the fake keeps the secret itself. Same test. */
  const secrets = new Map<string, string>();
  /** Every secret this fake has ever issued, in order. */
  const issued: string[] = [];
  let used = options.used ?? 0;

  const key = (r: RevisionRequest) => r.questionId + '|' + r.lang;

  const client: AiClient = {
    isConfigured: () => options.configured ?? true,

    async claim(request) {
      if (!plan) return { code: 'no_plan', secret: null };
      if ((options.question ?? QUESTION_ROW) === null) return { code: 'not_found', secret: null };

      const found = rows.get(key(request));
      // A free read and somebody else's call are told no secret, because
      // neither has a call of ours to finish.
      if (found?.status === 'ready') return { code: 'ready', secret: null };
      if (found?.status === 'generating') return { code: 'generating', secret: null };

      if (used >= AI_DAILY_CAP) return { code: 'limit', secret: null };

      // The primary key decides. In one process that is `Map.has`.
      rows.set(key(request), {
        questionId: request.questionId,
        lang: request.lang,
        status: 'generating',
        body: null,
        sources: [],
        audioPath: null,
        editedByTeacher: false,
      });
      used += 1;

      const secret = `claim-secret-${issued.length + 1}`;
      issued.push(secret);
      secrets.set(key(request), secret);
      return { code: 'claimed' satisfies ClaimCode, secret };
    },

    async get(request) {
      return rows.get(key(request)) ?? null;
    },

    async question() {
      return options.question === undefined ? QUESTION_ROW : options.question;
    },

    async finish(request, result, secret) {
      // `finish_ai_explanation` answers false without the claim's secret,
      // and `createSupabaseAiClient` turns that false into a throw.
      if (secret === null || secrets.get(key(request)) !== secret) {
        throw new Error('finish saved nothing');
      }
      secrets.delete(key(request));
      rows.set(key(request), {
        questionId: request.questionId,
        lang: request.lang,
        status: 'ready',
        body: result.body,
        sources: result.sources,
        audioPath: null,
        editedByTeacher: false,
      });
    },

    async fail(request, secret) {
      const found = rows.get(key(request));
      if (found?.status !== 'generating') return;
      // NO SECRET, NO REFUND. This is the hole issue 37 closes: the student's
      // own browser holds the same access token our server does.
      if (secret === null || secrets.get(key(request)) !== secret) return;
      secrets.delete(key(request));
      rows.set(key(request), { ...found, status: 'failed' });
      used = Math.max(used - 1, 0);
    },
  };

  return { client, rows, issued, usedToday: () => used };
}

function fakeExplainer(result: ExplainResult = RESULT): Explainer & { calls: number } {
  const explainer = {
    calls: 0,
    isConfigured: () => true,
    async explain() {
      explainer.calls += 1;
      return result;
    },
  };
  return explainer;
}

function run(
  overrides: {
    body?: unknown;
    session?: AuthSession | null;
    client?: AiClient;
    explainer?: Explainer;
    limiter?: ReturnType<typeof createRateLimiter>;
  } = {},
) {
  return handleRevision({
    // `in`, not `??`: one of the cases below sends a null body on purpose.
    body: 'body' in overrides ? overrides.body : { question_id: QUESTION, lang: 'en' },
    session: overrides.session === undefined ? session() : overrides.session,
    client: overrides.client ?? fakeClient().client,
    explainer: overrides.explainer ?? fakeExplainer(),
    limiter: overrides.limiter ?? createRateLimiter(),
  });
}

describe('handleRevision: who may ask', () => {
  it('refuses a visitor who is not signed in', async () => {
    const explainer = fakeExplainer();
    const reply = await run({ session: null, explainer });
    expect(reply.status).toBe(401);
    expect(explainer.calls).toBe(0);
  });

  it('refuses a student on no plan and never calls the model', async () => {
    const { client, usedToday } = fakeClient({ plan: false });
    const explainer = fakeExplainer();

    const reply = await run({ client, explainer });

    expect(reply.status).toBe(402);
    expect(reply.body).toEqual({ error: 'no_plan' });
    expect(explainer.calls).toBe(0);
    expect(usedToday()).toBe(0);
  });

  it('refuses a question that is not readable', async () => {
    const { client } = fakeClient({ question: null });
    const explainer = fakeExplainer();

    const reply = await run({ client, explainer });

    expect(reply.status).toBe(404);
    expect(explainer.calls).toBe(0);
  });

  it('says so when Supabase is not set up', async () => {
    const { client } = fakeClient({ configured: false });
    const reply = await run({ client });
    expect(reply.status).toBe(503);
  });

  it('refuses a body that is not a question id and a language', async () => {
    for (const body of [null, {}, { question_id: 'nope', lang: 'en' }, { question_id: QUESTION }, { question_id: QUESTION, lang: 'both' }]) {
      const reply = await run({ body });
      expect(reply.status).toBe(400);
    }
  });
});

describe('handleRevision: a saved explanation is free', () => {
  it('returns it at once, calls nothing, and does not count it', async () => {
    const { client, usedToday } = fakeClient();
    const first = fakeExplainer();

    // The first ask pays for the call.
    const made = await run({ client, explainer: first });
    expect(made.status).toBe(200);
    expect(first.calls).toBe(1);
    expect(usedToday()).toBe(1);

    // The second one is free.
    const second = fakeExplainer();
    const saved = await run({ client, explainer: second });

    expect(saved.status).toBe(200);
    expect(second.calls).toBe(0);
    expect(usedToday()).toBe(1);
    expect(saved.body).toEqual(made.body);
  });

  it('gives the explanation back, not just an ok', async () => {
    const reply = await run();
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      status: 'ready',
      body: RESULT.body,
      sources: RESULT.sources,
    });
  });
});

describe('handleRevision: 30 a day', () => {
  it('refuses the 31st new one with the code limit', async () => {
    const { client, usedToday } = fakeClient({ used: AI_DAILY_CAP });
    const explainer = fakeExplainer();

    const reply = await run({ client, explainer });

    expect(reply.status).toBe(429);
    expect(reply.body).toEqual({ error: 'limit' });
    expect(explainer.calls).toBe(0);
    expect(usedToday()).toBe(AI_DAILY_CAP);
  });

  it('still serves a SAVED explanation to a student at the cap', async () => {
    const { client } = fakeClient({ used: AI_DAILY_CAP - 1 });
    await run({ client }); // uses the last one
    const explainer = fakeExplainer();

    const reply = await run({ client, explainer });

    expect(reply.status).toBe(200);
    expect(explainer.calls).toBe(0);
  });
});

describe('handleRevision: two students at once', () => {
  it('calls the explainer exactly once', async () => {
    const { client, usedToday } = fakeClient();
    const explainer = fakeExplainer();

    const [a, b] = await Promise.all([
      run({ client, explainer }),
      run({ client, explainer, limiter: createRateLimiter() }),
    ]);

    expect(explainer.calls).toBe(1);
    expect(usedToday()).toBe(1);

    // One of the two wrote it; the other was told it is on its way.
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 202]);
    const waiting = [a, b].find((r) => r.status === 202);
    expect(waiting?.body).toEqual({ status: 'generating' });
  });
});

describe('handleRevision: the model fails', () => {
  it('gives the call back and says the explanation failed', async () => {
    const { client, usedToday, rows } = fakeClient();
    const broken: Explainer = {
      isConfigured: () => true,
      explain: vi.fn(async () => {
        throw new Error('upstream 529');
      }),
    };

    const reply = await run({ client, explainer: broken });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'ai_failed' });
    // The student must not lose 1 of 30 over our outage.
    expect(usedToday()).toBe(0);
    expect(rows.get(QUESTION + '|en')?.status).toBe('failed');
  });

  it('does not leak the upstream error text', async () => {
    const { client } = fakeClient();
    const broken: Explainer = {
      isConfigured: () => true,
      explain: async () => {
        throw new Error('ANTHROPIC_API_KEY sk-ant-secret is invalid');
      },
    };

    const reply = await run({ client, explainer: broken });
    expect(JSON.stringify(reply.body)).not.toContain('sk-ant');
  });

  it('lets the next ask try again', async () => {
    const { client, usedToday } = fakeClient();
    const broken: Explainer = {
      isConfigured: () => true,
      explain: async () => {
        throw new Error('nope');
      },
    };
    await run({ client, explainer: broken });

    const working = fakeExplainer();
    const reply = await run({ client, explainer: working });

    expect(reply.status).toBe(200);
    expect(working.calls).toBe(1);
    expect(usedToday()).toBe(1);
  });
});

describe('handleRevision: 10 a minute', () => {
  it('refuses the 11th request in the same minute', async () => {
    const { client } = fakeClient();
    const explainer = fakeExplainer();
    const limiter = createRateLimiter();

    for (let i = 0; i < 10; i += 1) {
      const reply = await handleRevision({
        body: { question_id: QUESTION, lang: 'en' },
        session: session(),
        client,
        explainer,
        limiter,
        now: 1_000,
      });
      expect(reply.status).not.toBe(429);
    }

    const over = await handleRevision({
      body: { question_id: QUESTION, lang: 'en' },
      session: session(),
      client,
      explainer,
      limiter,
      now: 1_000,
    });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: 'rate' });
  });

  it('counts per user, so one student cannot block another', async () => {
    const limiter = createRateLimiter();
    const other = '33333333-3333-4333-8333-333333333333';

    for (let i = 0; i < 10; i += 1) {
      limiter.take(STUDENT, 1_000);
    }
    expect(limiter.take(STUDENT, 1_000)).toBe(false);
    expect(limiter.take(other, 1_000)).toBe(true);
  });

  it('is checked before the plan, so a flood costs no database calls', async () => {
    const { client } = fakeClient();
    const claim = vi.spyOn(client, 'claim');
    const limiter = createRateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.take(STUDENT, 1_000);

    const reply = await handleRevision({
      body: { question_id: QUESTION, lang: 'en' },
      session: session(),
      client,
      explainer: fakeExplainer(),
      limiter,
      now: 1_000,
    });

    expect(reply.status).toBe(429);
    expect(claim).not.toHaveBeenCalled();
  });
});

/**
 * THE CLAIM SECRET (issue 37-ai-claim-secret).
 *
 * The hole this closes is not a permission mistake, it is the shape of the
 * app: there is no service-role key, so every Supabase call carries the
 * STUDENT'S OWN access token. `claimed_by = auth.uid()` is therefore just as
 * true in the student's browser as it is in this route, and the student could
 * post `rpc/fail_ai_explanation` for their own in-flight claim: refund,
 * reload, repeat. The 30-a-day cap was the model spend ceiling, and it never
 * filled.
 *
 * So the claim now hands back a one-time secret, `finish` and `fail` need it,
 * and it may only ever live in this file's local variables.
 */
describe('handleRevision: the claim secret never leaves the server', () => {
  it('passes the claim secret to finish', async () => {
    const t = fakeClient();
    const finish = vi.spyOn(t.client, 'finish');

    const reply = await run({ client: t.client });

    expect(reply.status).toBe(200);
    expect(t.issued).toHaveLength(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][2]).toBe(t.issued[0]);
  });

  it('passes the claim secret to fail, which is what makes the refund work', async () => {
    const t = fakeClient();
    const fail = vi.spyOn(t.client, 'fail');
    const explainer: Explainer = {
      isConfigured: () => true,
      async explain() {
        throw new Error('the model timed out');
      },
    };

    const reply = await run({ client: t.client, explainer });

    expect(reply.status).toBe(502);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][1]).toBe(t.issued[0]);
    // The refund only landed BECAUSE the secret went with it.
    expect(t.usedToday()).toBe(0);
    expect(t.rows.get(`${QUESTION}|en`)?.status).toBe('failed');
  });

  it('passes it to fail when the question vanishes between claim and read', async () => {
    const t = fakeClient();
    const fail = vi.spyOn(t.client, 'fail');
    vi.spyOn(t.client, 'question').mockResolvedValue(null);

    const reply = await run({ client: t.client });

    expect(reply.status).toBe(404);
    expect(fail.mock.calls[0][1]).toBe(t.issued[0]);
    expect(t.usedToday()).toBe(0);
  });

  it('keeps the secret out of every reply body, saved or fresh', async () => {
    const t = fakeClient();

    const made = await run({ client: t.client });
    const saved = await run({ client: t.client });

    const secret = t.issued[0];
    expect(secret).toBeTruthy();
    for (const reply of [made, saved]) {
      expect(reply.status).toBe(200);
      expect(JSON.stringify(reply.body)).not.toContain(secret);
      expect(Object.keys(reply.body)).not.toContain('secret');
    }
  });

  it('keeps the secret out of a refusal body too', async () => {
    const t = fakeClient();
    const explainer: Explainer = {
      isConfigured: () => true,
      async explain() {
        throw new Error('the model timed out');
      },
    };

    const reply = await run({ client: t.client, explainer });

    expect(JSON.stringify(reply.body)).not.toContain(t.issued[0]);
  });

  it('never logs it, because this layer never logs at all', async () => {
    const t = fakeClient();
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    try {
      await run({ client: t.client });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('answers 202 and asks for nothing when somebody else holds the claim', async () => {
    // The browser-side attack ends here. A student who posts
    // `rpc/claim_ai_explanation` themselves gets a secret, but the row is
    // then `generating`, so OUR claim answers `generating`, the explainer is
    // never called, and no Claude call is paid for.
    const t = fakeClient();
    const explainer = fakeExplainer();

    // Somebody's claim is already in flight.
    await t.client.claim({ questionId: QUESTION, lang: 'en' });
    const before = t.usedToday();

    const reply = await run({ client: t.client, explainer });

    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ status: 'generating' });
    expect(explainer.calls).toBe(0);
    expect(t.usedToday()).toBe(before);
  });
});
