/**
 * GET /api/revision/audio, the decision logic (issue 25-revision-audio).
 *
 * The audio bucket is PRIVATE, exactly like the papers one, so a student
 * never gets a bucket URL. They get a redirect to a short-lived signed URL,
 * minted on the server for a row RLS already let them read. That is why the
 * `<audio src>` points at our own route and not at Supabase.
 *
 * Kept out of the route file so the tests drive it directly, the same split
 * as `revision-route.ts`.
 *
 * No real network call and no real key (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '@/lib/papers/memory-file-store';
import type { AuthSession } from '@/lib/auth/types';
import { explanationAudioPath, readAudioRequest } from '../audio';
import { handleAudioUrl } from '../audio-route';
import type { AiClient, Explanation } from '../types';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';

function session(): AuthSession {
  return { accessToken: 'token', refreshToken: 'r', userId: STUDENT, role: 'student' };
}

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

function stored(audioPath: string | null): Explanation {
  return {
    questionId: QUESTION,
    lang: 'en',
    status: 'ready',
    body: {
      exam: 'UGC NET',
      topic: 'Parliament',
      question: 'Which house is the Council of States?',
      sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
      remember: 'Rajya Sabha = Council of States.',
    },
    sources: [],
    audioPath,
    editedByTeacher: false,
  };
}

function fakeClient(row: Explanation | null, configured = true): AiClient {
  return {
    isConfigured: () => configured,
    claim: async () => ({ code: 'ready' as const, secret: null }),
    get: async () => row,
    question: async () => null,
    finish: async () => {},
    fail: async () => {},
  };
}

describe('readAudioRequest', () => {
  it('takes a uuid and one of the two stored languages', () => {
    expect(readAudioRequest(params(`question_id=${QUESTION}&lang=hi`))).toEqual({
      questionId: QUESTION,
      lang: 'hi',
    });
  });

  it('refuses anything else', () => {
    expect(readAudioRequest(params('question_id=nope&lang=en'))).toBeNull();
    expect(readAudioRequest(params(`question_id=${QUESTION}&lang=both`))).toBeNull();
    expect(readAudioRequest(params(`question_id=${QUESTION}`))).toBeNull();
    expect(readAudioRequest(params(''))).toBeNull();
  });
});

describe('handleAudioUrl', () => {
  it('redirects to a signed URL for a saved file', async () => {
    const path = explanationAudioPath(QUESTION, 'en');
    const store = createMemoryFileStore();
    await store.upload({ path, contentType: 'audio/mpeg', bytes: new Uint8Array([1, 2, 3]) });

    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: fakeClient(stored(path)),
      store,
    });

    expect(reply.status).toBe(302);
    if (reply.kind !== 'play') throw new Error('expected a redirect');
    expect(reply.location).toContain(path);
  });

  it('refuses a signed-out caller', async () => {
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: null,
      client: fakeClient(stored('x')),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(401);
  });

  it('refuses a bad query', async () => {
    const reply = await handleAudioUrl({
      params: params('question_id=nope&lang=en'),
      session: session(),
      client: fakeClient(stored('x')),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(400);
  });

  it('says so when Supabase is not set up', async () => {
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: fakeClient(stored('x'), false),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(503);
  });

  it('is a 404 when the explanation has no audio yet', async () => {
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: fakeClient(stored(null)),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(404);
  });

  it('is a 404 when the row is not readable at all (RLS)', async () => {
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: fakeClient(null),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(404);
  });

  it('is a 404 when the row points at a file nobody stored', async () => {
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: fakeClient(stored('explanations/gone/en.mp3')),
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(404);
  });

  it('never lets a thrown error out', async () => {
    const broken: AiClient = {
      ...fakeClient(stored('x')),
      get: async () => {
        throw new Error('rest call died');
      },
    };
    const reply = await handleAudioUrl({
      params: params(`question_id=${QUESTION}&lang=en`),
      session: session(),
      client: broken,
      store: createMemoryFileStore(),
    });
    expect(reply.status).toBe(404);
  });
});
