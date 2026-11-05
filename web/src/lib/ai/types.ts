/**
 * The Revision (AI) contract (issue 22-revision-api).
 *
 * F-F4, the rule the whole slice exists for: ONE model call per question and
 * language, ever. A saved explanation is free and unlimited. A new one costs
 * 1 of the student's 30 for the India day.
 *
 * Both outside services sit behind an interface here, so the tests fake them:
 * no real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 *  * `AiClient`  -- server side, carries the student's own access token, so
 *                   the SQL in `0022_ai.sql` is the real gate.
 *  * `Explainer` -- the model. Faked in every test.
 *  * `RateLimiter` -- 10 requests a minute per user (C).
 *
 * Nothing here reads `process.env` or calls `fetch`, so importing this file
 * can never break a build that has no environment variables.
 */
import type { Lang } from '@/lib/i18n';
import type { QuestionOptions } from '@/lib/questions/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** F6 (locked): Haiku. Boss's model pin, also stored on every saved row. */
export const EXPLAINER_MODEL = 'claude-haiku-5-5';

/** F4 (locked): at most two web searches in the one call. */
export const MAX_WEB_SEARCHES = 2;

/** X6 (locked): 30 NEW explanations an India day, on the AI plan AND on Pro. */
export const AI_DAILY_CAP = 30;

/** C (locked): 10 requests a minute per user. */
export const RATE_LIMIT_PER_MINUTE = 10;
export const RATE_WINDOW_MS = 60_000;

// --------------------------------------------------------------------------
// What the model gives back
// --------------------------------------------------------------------------

/** One titled chunk of the explanation. The UI draws heading + body. */
export interface ExplanationSection {
  heading: string;
  body: string;
}

/** A link under the explanation. From the web search, or named by the model. */
export interface ExplanationSource {
  title: string;
  url: string;
}

/** The longest url we will store or render. A real source is far shorter. */
export const MAX_SOURCE_URL = 2_000;

/**
 * A source url we are willing to put in an `href`, or null
 * (issue 32-ai-claim-tokens).
 *
 * A source is rendered as a real anchor the student taps
 * (`revision-panel.tsx`), so `javascript:` or `data:` in that slot is not a
 * bad citation, it is code running in the student's session. The model path
 * checked this from the start; the two STORED readers did not, so a row
 * written by a hand-posted REST call was rendered as given.
 *
 * ONE definition, used by the model reply reader
 * (`anthropic-explainer.ts`), by both stored-row readers
 * (`explanation-row.ts` for the browser, `supabase-ai-client.ts` for the
 * server) and mirrored by a CHECK in `0032_ai_claim_tokens.sql`. The
 * database is the gate; this is what stops an already-stored row from being
 * rendered.
 *
 * `new URL()` also normalises, so the scheme comes back lower case and the
 * stored text matches what the SQL CHECK accepts.
 */
export function readSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_SOURCE_URL) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    // Not a url at all: a relative path, or prose the model made up.
    return null;
  }
}

/**
 * The structured output. Shape is fixed by the JSON schema the real explainer
 * sends, so the UI never has to parse prose.
 */
export interface ExplanationBody {
  exam: string;
  topic: string;
  /** The question in short, for the chip row at the top of the screen. */
  question: string;
  sections: ExplanationSection[];
  /** One line to memorise. The last card on the screen. */
  remember: string;
}

/** One saved row of `ai_explanations`, as the app passes it around. */
export interface Explanation {
  questionId: string;
  lang: Lang;
  status: ExplanationStatus;
  body: ExplanationBody | null;
  sources: ExplanationSource[];
  /** Set by issue 25 (TTS). Always null in this slice. */
  audioPath: string | null;
  /** True after a teacher corrected it. The UI must then drop the AI label. */
  editedByTeacher: boolean;
}

export type ExplanationStatus = 'generating' | 'ready' | 'failed';

export function isExplanationStatus(value: unknown): value is ExplanationStatus {
  return value === 'generating' || value === 'ready' || value === 'failed';
}

// --------------------------------------------------------------------------
// The one word the database answers with
// --------------------------------------------------------------------------

/**
 * What `claim_ai_explanation()` returns. The route does exactly what it says
 * and decides nothing itself, because the decision has to be one transaction.
 */
export type ClaimCode =
  /** Not on the AI plan or Pro. Show the Rs 100 card. */
  | 'no_plan'
  /** The question is not live and not the caller's own. */
  | 'not_found'
  /** Saved already. Read it; costs nothing. */
  | 'ready'
  /** Somebody else's call is in flight. Costs nothing. */
  | 'generating'
  /** 30 new ones used today. Saved ones still work. */
  | 'limit'
  /** You won the race: call the model, then `finish`. */
  | 'claimed';

const CLAIM_CODES: readonly ClaimCode[] = [
  'no_plan',
  'not_found',
  'ready',
  'generating',
  'limit',
  'claimed',
];

export function isClaimCode(value: unknown): value is ClaimCode {
  return typeof value === 'string' && (CLAIM_CODES as readonly string[]).includes(value);
}

// --------------------------------------------------------------------------
// The request
// --------------------------------------------------------------------------

export interface RevisionRequest {
  questionId: string;
  lang: Lang;
}

/**
 * Validate anything into a `RevisionRequest`, or null.
 *
 * `lang` is a stored LANGUAGE, never the display mode `both`: an explanation
 * is written in one language, like the question it explains.
 */
export function readRevisionRequest(body: unknown): RevisionRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  // Accepted under the wire name the SQL function uses, so the route body,
  // the RPC call and the table column are all spelled the same.
  const questionId = raw.question_id ?? raw.questionId;
  if (typeof questionId !== 'string' || !UUID_RE.test(questionId)) return null;

  const lang = raw.lang;
  if (lang !== 'en' && lang !== 'hi') return null;

  return { questionId, lang };
}

// --------------------------------------------------------------------------
// The model
// --------------------------------------------------------------------------

/**
 * Everything the model is given about one question.
 *
 * Every string in `question` came out of a PDF or was typed by a teacher, so
 * it is UNTRUSTED DATA. `buildExplainPrompt` wraps it, and the prompt says so
 * in as many words. See `prompt.ts`.
 */
export interface ExplainRequest {
  lang: Lang;
  /** Exam name for context, e.g. "UGC NET". Null when unknown. */
  exam: string | null;
  /** Topic name, when the question has one. */
  topic: string | null;
  question: {
    stem: string;
    options: QuestionOptions;
    /** 0 to 3, an index into `options`. */
    correctIdx: number;
    teacherExplanation: string | null;
  };
}

export interface ExplainResult {
  body: ExplanationBody;
  sources: ExplanationSource[];
  /** The model that answered. Stored, for the cost check (AS3). */
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** How many web searches the call actually used. Never above 2 (F4). */
  searches: number;
}

/** The model, behind one method. Faked in every test. */
export interface Explainer {
  /** False when the API key is missing, so a page can say "not set up". */
  isConfigured(): boolean;
  explain(request: ExplainRequest): Promise<ExplainResult>;
}

// --------------------------------------------------------------------------
// The database, behind one interface
// --------------------------------------------------------------------------

/** What the model needs to know about the question it is explaining. */
export interface QuestionForExplain {
  exam: string | null;
  topic: string | null;
  stem: string;
  options: QuestionOptions;
  correctIdx: number;
  teacherExplanation: string | null;
}

/** Server side. Carries the student's access token, so Postgres decides. */
export interface AiClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** The one transaction: plan, saved lookup, 30-a-day, and the race. */
  claim(request: RevisionRequest): Promise<ClaimCode>;
  /** Read a saved explanation. Null when there is none to read. */
  get(request: RevisionRequest): Promise<Explanation | null>;
  /** What the prompt is built from. Null when the question is not readable. */
  question(questionId: string): Promise<QuestionForExplain | null>;
  /** Save a finished explanation. */
  finish(request: RevisionRequest, result: ExplainResult): Promise<void>;
  /** Mark it failed and give the student their 1 of 30 back. */
  fail(request: RevisionRequest): Promise<void>;
}

/** 10 a minute per user. In memory: one process, one window (C). */
export interface RateLimiter {
  /** True when this request is allowed. False when the user is over. */
  take(key: string, now?: number): boolean;
}
