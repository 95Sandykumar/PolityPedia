/**
 * The decision logic behind POST /api/revision (issue 22-revision-api).
 *
 * Kept out of the route file so the tests drive it directly, the same split
 * as `admin-plans-route.ts`. The route file is a thin adapter.
 *
 * The order of the checks is the design:
 *
 *   1. rate limit  -- 10 a minute, before ANY database call, so a flood is
 *                     cheap to refuse (C).
 *   2. session     -- no cookie, no revision.
 *   3. body        -- a uuid and one of two languages.
 *   4. claim()     -- ONE transaction in Postgres decides everything that
 *                     costs money: the plan, the saved lookup, the 30-a-day
 *                     cap, and who wins the race. This file never decides it.
 *   5. the model   -- only on `claimed`, and exactly once.
 *
 * Nothing here is the gate. The gate is `claim_ai_explanation()` in
 * `supabase/migrations/0022_ai.sql`, which runs under the student's own
 * access token. This is the part that is allowed to be wrong without costing
 * anybody money.
 *
 * Security: replies carry a fixed code, never a thrown error. An upstream
 * message can quote a URL or a key.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  readRevisionRequest,
  type AiClient,
  type Explainer,
  type Explanation,
  type ExplanationBody,
  type RateLimiter,
  type RevisionRequest,
} from './types';

/**
 * The audio step (issue 25-revision-audio).
 *
 * SYNCHRONOUS and returns nothing, on purpose. Making audio is a BACKGROUND
 * step: the student must get their explanation now, not after a voice
 * provider has finished reading it out. So this file only ever hands the
 * finished text over; the route file is what schedules the work, with
 * `after()` from `next/server`, which keeps the function alive past the
 * response instead of letting a dangling promise die with it.
 *
 * Optional, so issue 22's own tests keep working with no step at all.
 */
export type AudioStep = (request: RevisionRequest, body: ExplanationBody) => void;

export interface RevisionInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: AiClient;
  explainer: Explainer;
  limiter: RateLimiter;
  /** Injected clock, so the rate-limit tests are deterministic. */
  now?: number;
  /** Where a finished explanation goes to have its audio made (issue 25). */
  audio?: AudioStep;
}

/** What the route answers with. */
export type RevisionReply =
  | { status: 200; body: SavedExplanation }
  | { status: 202; body: { status: 'generating' } }
  | { status: number; body: { error: RevisionError } };

/**
 * The codes the UI switches on. `limit` is the one the issue names: the
 * screen then says "30 new explanations used today. Saved ones still work."
 */
export type RevisionError =
  | 'rate'
  | 'sign_in'
  | 'bad_request'
  | 'not_configured'
  | 'no_plan'
  | 'not_found'
  | 'limit'
  | 'ai_failed';

export interface SavedExplanation {
  status: 'ready';
  questionId: string;
  lang: string;
  body: Explanation['body'];
  sources: Explanation['sources'];
  audioPath: string | null;
  editedByTeacher: boolean;
}

function fail(status: number, error: RevisionError): RevisionReply {
  return { status, body: { error } };
}

/**
 * Hand a finished explanation to the audio step, and never let it matter.
 *
 * The student's reply is already decided by the time this runs. A step that
 * throws is a bug in the step, not a reason to hide an explanation somebody
 * paid for, which is exactly what the issue asks for: "with the unconfigured
 * provider the explanation still shows and no error reaches the student".
 */
function startAudio(
  audio: AudioStep | undefined,
  request: RevisionRequest,
  body: ExplanationBody,
): void {
  if (!audio) return;
  try {
    audio(request, body);
  } catch {
    // Nothing useful to do. The explanation stays silent until the next read.
  }
}

/** Shape a stored row for the wire. Null body means it is not ready. */
function readable(found: Explanation | null, audio?: AudioStep): RevisionReply {
  if (!found || found.status !== 'ready' || !found.body) {
    // Claimed as ready a moment ago but not readable now: a teacher edit or a
    // cache miss. Telling the client "on its way" makes it retry, which is
    // right, and costs nothing because the row already exists.
    return { status: 202, body: { status: 'generating' } };
  }

  // A saved explanation with no audio: either it was written before this
  // slice existed, or a voice call broke. Reading it is the moment to make
  // the audio, once. `claim_explanation_audio()` is what stops a popular
  // question from starting a hundred voice calls.
  if (!found.audioPath) {
    startAudio(audio, { questionId: found.questionId, lang: found.lang }, found.body);
  }

  return {
    status: 200,
    body: {
      status: 'ready',
      questionId: found.questionId,
      lang: found.lang,
      body: found.body,
      sources: found.sources,
      audioPath: found.audioPath,
      editedByTeacher: found.editedByTeacher,
    },
  };
}

export async function handleRevision({
  body,
  session,
  client,
  explainer,
  limiter,
  now,
  audio,
}: RevisionInput): Promise<RevisionReply> {
  // The limiter is keyed on the user, so a signed-out flood all lands on one
  // bucket. That is deliberate: those requests are refused at step 2 anyway.
  const who = session?.userId ?? 'anonymous';
  if (!limiter.take(who, now)) return fail(429, 'rate');

  if (!session) return fail(401, 'sign_in');
  if (!client.isConfigured()) return fail(503, 'not_configured');

  const request = readRevisionRequest(body);
  if (!request) return fail(400, 'bad_request');

  let code: Awaited<ReturnType<AiClient['claim']>>;
  try {
    code = await client.claim(request);
  } catch {
    return fail(502, 'ai_failed');
  }

  switch (code) {
    case 'no_plan':
      // 402: this is a paywall, not a permission mistake. The UI shows the
      // Rs 100 card and keeps the teacher explanation visible.
      return fail(402, 'no_plan');
    case 'not_found':
      return fail(404, 'not_found');
    case 'limit':
      return fail(429, 'limit');
    case 'generating':
      return { status: 202, body: { status: 'generating' } };
    case 'ready':
      return readable(await client.get(request), audio);
    case 'claimed':
      break;
    default:
      return fail(502, 'ai_failed');
  }

  // We won the race, so from here on exactly one model call happens, and if
  // anything at all goes wrong the student gets their 1 of 30 back.
  return generate(request, client, explainer, audio);
}

async function generate(
  request: RevisionRequest,
  client: AiClient,
  explainer: Explainer,
  audio?: AudioStep,
): Promise<RevisionReply> {
  try {
    const question = await client.question(request.questionId);
    if (!question) {
      // Readable a microsecond ago, gone now. Release the row, no charge.
      await giveBack(client, request);
      return fail(404, 'not_found');
    }

    const result = await explainer.explain({
      lang: request.lang,
      exam: question.exam,
      topic: question.topic,
      question: {
        stem: question.stem,
        options: question.options,
        correctIdx: question.correctIdx,
        teacherExplanation: question.teacherExplanation,
      },
    });

    await client.finish(request, result);

    // Saved, so there is finally something to read out. This is the "after
    // `ready`" the issue names (issue 25-revision-audio).
    startAudio(audio, request, result.body);

    return {
      status: 200,
      body: {
        status: 'ready',
        questionId: request.questionId,
        lang: request.lang,
        body: result.body,
        sources: result.sources,
        audioPath: null,
        editedByTeacher: false,
      },
    };
  } catch {
    // The model timed out, refused, or gave a shape we could not read. None
    // of that is the student's fault, so the count goes back and the row is
    // released for a retry.
    await giveBack(client, request);
    return fail(502, 'ai_failed');
  }
}

/** Never let the refund itself throw: that would hide the real failure. */
async function giveBack(client: AiClient, request: RevisionRequest): Promise<void> {
  try {
    await client.fail(request);
  } catch {
    // Nothing useful to do. The row stays `generating` and the next slice's
    // sweeper (or a retry after the row expires) picks it up.
  }
}
