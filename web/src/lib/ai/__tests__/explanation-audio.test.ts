/**
 * Revision audio, the background step (issue 25-revision-audio).
 *
 * Definition of done: "After an explanation is ready, an audio file is made
 * once in the background and saved."
 *
 * The test the issue asks for, line by line:
 *
 *  1. "fake Speech is called once per (question, lang) even when 2 students
 *     open it"  -> two steps run together, `speak` runs ONCE, one object is
 *     stored.
 *  2. "audio_path set"  -> the fake client holds the path the store holds.
 *  3. "with the unconfigured provider the explanation still shows and no
 *     error reaches the student"  -> `makeExplanationAudio` answers
 *     `not_configured` without throwing, nothing is claimed, and
 *     `handleRevision` still replies 200 with the explanation.
 *
 * The fake `ExplanationAudioClient` below copies the SQL semantics of
 * `claim_explanation_audio()`. `test/revision-audio.test.ts` is what proves
 * those semantics in real Postgres; this file proves the step obeys them.
 *
 * No real network call, no real key, no real voice provider (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '@/lib/papers/memory-file-store';
import type { AuthSession } from '@/lib/auth/types';
import {
  AUDIO_CONTENT_TYPE,
  AUDIO_SPEEDS,
  DEFAULT_AUDIO_SPEED,
  explanationAudioPath,
  explanationAudioUrl,
  explanationSpeechText,
  type AudioClaimOutcome,
  type ExplanationAudioClient,
} from '../audio';
import { makeExplanationAudio } from '../explanation-audio';
import { createMemorySpeech } from '../memory-speech';
import { handleRevision } from '../revision-route';
import { createRateLimiter } from '../rate-limit';
import { createUnconfiguredSpeech } from '../unconfigured-speech';
import type {
  AiClient,
  ClaimCode,
  ExplainResult,
  ExplanationBody,
  Explainer,
  Explanation,
  QuestionForExplain,
  RevisionRequest,
} from '../types';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';

const BODY: ExplanationBody = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [
    { heading: 'The answer', body: 'The Rajya Sabha is the Council of States.' },
    { heading: 'Why the others are wrong', body: 'The Lok Sabha is the House of the People.' },
  ],
  remember: 'Rajya Sabha = Council of States.',
};

/** What one (question, lang) looks like inside the fake database. */
interface AudioRow {
  ready: boolean;
  audioStatus: 'none' | 'making' | 'ready' | 'failed';
  audioPath: string | null;
}

function key(request: RevisionRequest): string {
  return `${request.questionId}:${request.lang}`;
}

/**
 * A fake audio client with the same decision order as
 * `claim_explanation_audio()`: the explanation has to be ready, and the
 * UPDATE only matches a row nobody has claimed.
 */
function fakeAudioClient(
  seed: Partial<AudioRow> = {},
  options: { configured?: boolean } = {},
) {
  const rows = new Map<string, AudioRow>();
  rows.set(`${QUESTION}:en`, {
    ready: seed.ready ?? true,
    audioStatus: seed.audioStatus ?? 'none',
    audioPath: seed.audioPath ?? null,
  });
  rows.set(`${QUESTION}:hi`, {
    ready: seed.ready ?? true,
    audioStatus: seed.audioStatus ?? 'none',
    audioPath: seed.audioPath ?? null,
  });

  // The claim secret (issue 37-ai-claim-secret). Postgres stores a sha256 of
  // it; the fake keeps the secret itself, which tests the same thing: a step
  // that does not pass the claim's own secret back can neither save nor
  // release the row.
  const secrets = new Map<string, string>();
  let issued = 0;

  const claimAudio = vi.fn(async (request: RevisionRequest): Promise<AudioClaimOutcome> => {
    const row = rows.get(key(request));
    if (!row) return { code: 'not_found', secret: null };
    if (!row.ready) return { code: 'not_ready', secret: null };
    if (row.audioStatus === 'ready' && row.audioPath) return { code: 'ready', secret: null };
    if (row.audioStatus === 'making') return { code: 'making', secret: null };
    row.audioStatus = 'making';
    issued += 1;
    const secret = `audio-secret-${issued}`;
    secrets.set(key(request), secret);
    return { code: 'claimed', secret };
  });

  const finishAudio = vi.fn(
    async (request: RevisionRequest, path: string, secret: string | null) => {
      const row = rows.get(key(request));
      if (!row || row.audioStatus !== 'making' || path.trim().length === 0) return false;
      if (secret === null || secrets.get(key(request)) !== secret) return false;
      secrets.delete(key(request));
      row.audioStatus = 'ready';
      row.audioPath = path;
      return true;
    },
  );

  const failAudio = vi.fn(async (request: RevisionRequest, secret: string | null) => {
    const row = rows.get(key(request));
    if (!row || row.audioStatus !== 'making') return;
    if (secret === null || secrets.get(key(request)) !== secret) return;
    secrets.delete(key(request));
    row.audioStatus = 'failed';
  });

  const client: ExplanationAudioClient = {
    isConfigured: () => options.configured ?? true,
    claimAudio,
    finishAudio,
    failAudio,
  };

  return { client, claimAudio, finishAudio, failAudio, rows };
}

function run(
  extra: {
    audio?: ReturnType<typeof fakeAudioClient>;
    speech?: ReturnType<typeof createMemorySpeech>;
    store?: ReturnType<typeof createMemoryFileStore>;
    lang?: 'en' | 'hi';
  } = {},
) {
  const audio = extra.audio ?? fakeAudioClient();
  const speech = extra.speech ?? createMemorySpeech();
  const store = extra.store ?? createMemoryFileStore();
  const request: RevisionRequest = { questionId: QUESTION, lang: extra.lang ?? 'en' };

  return {
    audio,
    speech,
    store,
    request,
    go: () =>
      makeExplanationAudio({
        request,
        body: BODY,
        audio: audio.client,
        speech: speech.speech,
        store,
      }),
  };
}

describe('explanationSpeechText', () => {
  it('reads the question, every section and the Remember line', () => {
    const text = explanationSpeechText(BODY);
    expect(text).toContain('Which house is the Council of States?');
    expect(text).toContain('The answer');
    expect(text).toContain('The Rajya Sabha is the Council of States.');
    expect(text).toContain('Why the others are wrong');
    expect(text).toContain('Rajya Sabha = Council of States.');
  });

  it('is one block of plain text with no empty lines', () => {
    const text = explanationSpeechText(BODY);
    expect(text.includes('\n\n\n')).toBe(false);
    expect(text.trim()).toBe(text);
  });
});

describe('explanationAudioPath', () => {
  it('is one fixed path per question and language', () => {
    expect(explanationAudioPath(QUESTION, 'en')).toBe(explanationAudioPath(QUESTION, 'en'));
    expect(explanationAudioPath(QUESTION, 'en')).not.toBe(explanationAudioPath(QUESTION, 'hi'));
    expect(explanationAudioPath(QUESTION, 'en')).toContain(QUESTION);
  });

  it('points the player at our own route, never at a bucket', () => {
    const url = explanationAudioUrl(QUESTION, 'en');
    expect(url.startsWith('/api/revision/audio?')).toBe(true);
    expect(url).toContain(QUESTION);
    expect(url).toContain('lang=en');
  });
});

describe('the speed chips', () => {
  it('offers exactly 1x, 1.25x and 1.5x, starting at 1x (DESIGN.md 8)', () => {
    expect(AUDIO_SPEEDS).toEqual([1, 1.25, 1.5]);
    expect(DEFAULT_AUDIO_SPEED).toBe(1);
  });
});

describe('makeExplanationAudio: made once', () => {
  it('makes and saves the audio, and sets the path', async () => {
    const t = run();

    expect(await t.go()).toBe('made');

    expect(t.speech.calls()).toHaveLength(1);
    expect(t.speech.calls()[0].lang).toBe('en');
    expect(t.speech.calls()[0].text).toContain('Council of States');

    const path = explanationAudioPath(QUESTION, 'en');
    expect(t.store.paths()).toEqual([path]);
    expect(t.audio.rows.get(`${QUESTION}:en`)?.audioPath).toBe(path);
    expect(t.audio.rows.get(`${QUESTION}:en`)?.audioStatus).toBe('ready');
  });

  it('uploads the bytes the voice gave back, with an audio content type', async () => {
    const t = run();
    await t.go();

    const stored = t.store.read(explanationAudioPath(QUESTION, 'en'));
    expect(stored).toBeDefined();
    expect(stored?.byteLength).toBeGreaterThan(0);
    expect(t.speech.speech.contentType).toBe(AUDIO_CONTENT_TYPE);
  });

  it('calls the voice ONCE when two students open the same explanation', async () => {
    const audio = fakeAudioClient();
    const speech = createMemorySpeech();
    const store = createMemoryFileStore();

    // Two students, one explanation, at the same instant.
    const both = await Promise.all([
      run({ audio, speech, store }).go(),
      run({ audio, speech, store }).go(),
    ]);

    expect(both.filter((code) => code === 'made')).toHaveLength(1);
    expect(both.filter((code) => code === 'making')).toHaveLength(1);
    // The promise of the whole slice: one paid voice call for both students.
    expect(speech.calls()).toHaveLength(1);
    expect(store.paths()).toHaveLength(1);
  });

  it('makes nothing a second time once the audio is saved', async () => {
    const audio = fakeAudioClient();
    const speech = createMemorySpeech();
    const store = createMemoryFileStore();

    expect(await run({ audio, speech, store }).go()).toBe('made');
    expect(await run({ audio, speech, store }).go()).toBe('ready');

    expect(speech.calls()).toHaveLength(1);
  });

  it('makes one file per language (F-F5: Hindi and English)', async () => {
    const audio = fakeAudioClient();
    const speech = createMemorySpeech();
    const store = createMemoryFileStore();

    expect(await run({ audio, speech, store, lang: 'en' }).go()).toBe('made');
    expect(await run({ audio, speech, store, lang: 'hi' }).go()).toBe('made');

    expect(speech.calls().map((call) => call.lang)).toEqual(['en', 'hi']);
    expect(store.paths()).toHaveLength(2);
  });

  it('waits until the explanation itself is ready', async () => {
    const t = run({ audio: fakeAudioClient({ ready: false }) });
    expect(await t.go()).toBe('not_ready');
    expect(t.speech.calls()).toHaveLength(0);
    expect(t.store.paths()).toHaveLength(0);
  });
});

describe('makeExplanationAudio: nothing reaches the student', () => {
  it('skips the work when no voice provider is set up (X5)', async () => {
    const audio = fakeAudioClient();
    const store = createMemoryFileStore();

    const outcome = await makeExplanationAudio({
      request: { questionId: QUESTION, lang: 'en' },
      body: BODY,
      audio: audio.client,
      speech: createUnconfiguredSpeech(),
      store,
    });

    expect(outcome).toBe('not_configured');
    // Nothing claimed means the row is free for the day a provider is picked.
    expect(audio.claimAudio).not.toHaveBeenCalled();
    expect(store.paths()).toHaveLength(0);
  });

  it('skips the work when Supabase is not set up', async () => {
    const t = run({ audio: fakeAudioClient({}, { configured: false }) });
    expect(await t.go()).toBe('not_configured');
    expect(t.speech.calls()).toHaveLength(0);
  });

  it('gives the row back when the voice call breaks, and never throws', async () => {
    const speech = createMemorySpeech();
    speech.failNext();
    const t = run({ speech });

    expect(await t.go()).toBe('failed');
    expect(t.audio.failAudio).toHaveBeenCalledTimes(1);
    expect(t.audio.rows.get(`${QUESTION}:en`)?.audioStatus).toBe('failed');
    expect(t.store.paths()).toHaveLength(0);
  });

  it('gives the row back when the upload breaks, and never throws', async () => {
    const store = createMemoryFileStore();
    store.failNext();
    const t = run({ store });

    expect(await t.go()).toBe('failed');
    expect(t.audio.failAudio).toHaveBeenCalledTimes(1);
    expect(t.audio.rows.get(`${QUESTION}:en`)?.audioStatus).toBe('failed');
  });

  it('gives the row back when the save breaks, and never throws', async () => {
    const t = run();
    t.audio.client.finishAudio = async () => {
      throw new Error('rest call died');
    };

    expect(await t.go()).toBe('failed');
    expect(t.audio.failAudio).toHaveBeenCalledTimes(1);
  });

  it('answers not_found for an explanation that is gone', async () => {
    const t = run();
    t.audio.rows.delete(`${QUESTION}:en`);
    expect(await t.go()).toBe('not_found');
    expect(t.speech.calls()).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// The route hands the step the finished explanation
// --------------------------------------------------------------------------

const QUESTION_ROW: QuestionForExplain = {
  exam: 'UGC NET',
  topic: 'Parliament',
  stem: 'Which house is the Council of States?',
  options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
  correctIdx: 1,
  teacherExplanation: 'Article 80.',
};

const RESULT: ExplainResult = {
  body: BODY,
  sources: [{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }],
  model: 'claude-haiku-5-5',
  tokensIn: 900,
  tokensOut: 450,
  searches: 2,
};

function session(): AuthSession {
  return { accessToken: 'token', refreshToken: 'r', userId: STUDENT, role: 'student' };
}

/** Just enough AiClient to drive `handleRevision` past the gate. */
function fakeAiClient(seed: Explanation | null = null) {
  let row: Explanation | null = seed;

  const client: AiClient = {
    isConfigured: () => true,
    async claim() {
      const code: ClaimCode = row && row.status === 'ready' ? 'ready' : 'claimed';
      // A real claim hands a secret back only on `claimed`
      // (issue 37-ai-claim-secret), and `finish` below demands it.
      return { code, secret: code === 'claimed' ? 'text-claim-secret' : null };
    },
    async get() {
      return row;
    },
    async question() {
      return QUESTION_ROW;
    },
    async finish(request, result, secret) {
      if (secret !== 'text-claim-secret') throw new Error('finish saved nothing');
      row = {
        questionId: request.questionId,
        lang: request.lang,
        status: 'ready',
        body: result.body,
        sources: result.sources,
        audioPath: null,
        editedByTeacher: false,
      };
    },
    async fail() {},
  };

  return client;
}

const explainer: Explainer = {
  isConfigured: () => true,
  explain: async () => RESULT,
};

function post(
  client: AiClient,
  audio?: (request: RevisionRequest, body: ExplanationBody) => void,
) {
  return handleRevision({
    body: { question_id: QUESTION, lang: 'en' },
    session: session(),
    client,
    explainer,
    limiter: createRateLimiter(),
    audio,
  });
}

describe('handleRevision: the audio step', () => {
  it('hands a freshly written explanation to the step', async () => {
    const audio = vi.fn();
    const reply = await post(fakeAiClient(), audio);

    expect(reply.status).toBe(200);
    expect(audio).toHaveBeenCalledTimes(1);
    expect(audio.mock.calls[0][0]).toEqual({ questionId: QUESTION, lang: 'en' });
    expect(audio.mock.calls[0][1]).toEqual(BODY);
  });

  it('hands a saved explanation that has no audio yet to the step', async () => {
    const saved: Explanation = {
      questionId: QUESTION,
      lang: 'en',
      status: 'ready',
      body: BODY,
      sources: [],
      audioPath: null,
      editedByTeacher: false,
    };
    const audio = vi.fn();

    const reply = await post(fakeAiClient(saved), audio);

    expect(reply.status).toBe(200);
    // Explanations written before this slice have no audio. Reading one is
    // the moment to make it, once.
    expect(audio).toHaveBeenCalledTimes(1);
  });

  it('leaves a saved explanation that already has audio alone', async () => {
    const saved: Explanation = {
      questionId: QUESTION,
      lang: 'en',
      status: 'ready',
      body: BODY,
      sources: [],
      audioPath: explanationAudioPath(QUESTION, 'en'),
      editedByTeacher: false,
    };
    const audio = vi.fn();

    const reply = await post(fakeAiClient(saved), audio);

    expect(reply.status).toBe(200);
    expect(audio).not.toHaveBeenCalled();
  });

  it('still shows the explanation when the step throws (no error reaches the student)', async () => {
    const reply = await post(fakeAiClient(), () => {
      throw new Error('voice not configured');
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: 'ready' });
  });

  it('works with no step at all, so issue 22 keeps its own behaviour', async () => {
    const reply = await post(fakeAiClient());
    expect(reply.status).toBe(200);
  });
});

describe('the unconfigured voice provider (X5, human ticket H4)', () => {
  it('says it is not configured and throws a fixed message when called', async () => {
    const speech = createUnconfiguredSpeech();
    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('anything', 'en')).rejects.toThrow('voice not configured');
  });
});

/**
 * THE AUDIO CLAIM SECRET (issue 37-ai-claim-secret).
 *
 * Nothing is refunded for audio, so the hole here is not a free call, it is a
 * PAID one: release a voice call that is still running and the next read
 * starts a second one for the same words, billed per character. The claimant
 * could do that to their own in-flight call all day, because
 * `audio_claimed_by = auth.uid()` is true in their browser too.
 */
describe('makeExplanationAudio: the claim secret never leaves the server', () => {
  it('passes the secret to finishAudio', async () => {
    const t = run();
    expect(await t.go()).toBe('made');

    expect(t.audio.finishAudio).toHaveBeenCalledTimes(1);
    expect(t.audio.finishAudio.mock.calls[0][2]).toBe('audio-secret-1');
  });

  it('passes the secret to failAudio, which is what releases the row', async () => {
    const speech = createMemorySpeech();
    speech.failNext();
    const t = run({ speech });

    expect(await t.go()).toBe('failed');
    expect(t.audio.failAudio).toHaveBeenCalledTimes(1);
    expect(t.audio.failAudio.mock.calls[0][1]).toBe('audio-secret-1');
    // The row really moved, so a later read may retry it.
    expect(t.audio.rows.get(`${QUESTION}:en`)?.audioStatus).toBe('failed');
  });

  it('returns a word, never the secret', async () => {
    const t = run();
    const outcome = await t.go();
    expect(typeof outcome).toBe('string');
    expect(outcome).not.toContain('secret');
  });

  it('asks the voice for nothing when the claim is not ours', async () => {
    // A student who claims the audio from their own browser gets a secret and
    // nothing else: our step then reads `making` and stops before the voice.
    const t = run();
    await t.audio.client.claimAudio({ questionId: QUESTION, lang: 'en' });

    expect(await t.go()).toBe('making');
    expect(t.audio.finishAudio).not.toHaveBeenCalled();
    expect(t.audio.failAudio).not.toHaveBeenCalled();
  });
});
