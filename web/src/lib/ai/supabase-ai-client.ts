/**
 * Server-side AiClient over the Supabase REST API (issue 22-revision-api).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: the client carries the SIGNED-IN STUDENT'S OWN access token.
 * `claim_ai_explanation()` reads `auth.uid()` from that token, so the plan
 * gate, the question visibility rule and the 30-a-day counter are all decided
 * by Postgres for the right person. There is no service-role key here, so a
 * bug in a route handler cannot hand a student somebody else's quota.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry only a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { readOptions, type QuestionOptions } from '@/lib/questions/types';
import {
  isClaimCode,
  isExplanationStatus,
  readSourceUrl,
  type AiClient,
  type ClaimCode,
  type ExplainResult,
  type Explanation,
  type ExplanationBody,
  type ExplanationSource,
  type QuestionForExplain,
  type RevisionRequest,
} from './types';

const TABLE = '/rest/v1/ai_explanations';
const QUESTIONS = '/rest/v1/questions';
const RPC = '/rest/v1/rpc/';

export interface SupabaseAiClientOptions {
  /** The student's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface StoredRow {
  question_id?: unknown;
  lang?: unknown;
  status?: unknown;
  body?: unknown;
  sources?: unknown;
  audio_path?: unknown;
  edited_by_teacher?: unknown;
}

interface StoredQuestion {
  stem?: unknown;
  options?: unknown;
  // No `correct_idx`: it is not selectable off the table any more and arrives
  // through `question_keys()` instead (issue 30-exam-key-lock).
  teacher_explanation?: unknown;
  topic_id?: unknown;
  exams?: unknown;
  papers?: unknown;
}

/**
 * The server-side half of the same reader as `explanation-row.ts`. A source
 * whose url is not `http` or `https` is dropped here too: this row is handed
 * straight to the browser as the reply body of /api/revision
 * (issue 32-ai-claim-tokens).
 */
function readSources(value: unknown): ExplanationSource[] {
  if (!Array.isArray(value)) return [];
  const out: ExplanationSource[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { title, url } = raw as Record<string, unknown>;
    const link = readSourceUrl(url);
    if (!link) continue;
    out.push({ title: typeof title === 'string' ? title : link, url: link });
  }
  return out;
}

/** A stored body is only usable when it has renderable sections. */
function readBody(value: unknown): ExplanationBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) return null;

  const sections = raw.sections
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .filter((s) => typeof s.heading === 'string' && typeof s.body === 'string')
    .map((s) => ({ heading: String(s.heading), body: String(s.body) }));
  if (sections.length === 0) return null;

  return {
    exam: typeof raw.exam === 'string' ? raw.exam : '',
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    question: typeof raw.question === 'string' ? raw.question : '',
    sections,
    remember: typeof raw.remember === 'string' ? raw.remember : '',
  };
}

export function createSupabaseAiClient(options: SupabaseAiClientOptions): AiClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /** Same headers on every call: the project key plus the student's token. */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url } = required();
    const res = await doFetch(url + RPC + name, {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Supabase ' + name + ' failed with status ' + res.status);
    return (await res.json()) as unknown;
  }

  /**
   * One question's answer key through `question_keys()`, or null
   * (issue 30-exam-key-lock).
   *
   * NULL, never a throw, for every refusal including the exam lock: the
   * caller's next line is "no key, no explanation", and the revision route
   * already knows how to give the claim back without charging anybody.
   */
  async function keyFor(questionId: string): Promise<number | null> {
    const found = env();
    if (!found) return null;

    const res = await doFetch(found.url + RPC + 'question_keys', {
      method: 'POST',
      headers: restHeaders({ accept: 'application/json' }),
      body: JSON.stringify({ question_ids: [questionId] }),
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const key = (rows[0] as { correct_idx?: unknown }).correct_idx;
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > 3) return null;
    return key;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async claim(request: RevisionRequest): Promise<ClaimCode> {
      const code = await rpc('claim_ai_explanation', {
        question_id: request.questionId,
        lang: request.lang,
      });
      // An unknown word is read as "no plan", the same fail-closed choice the
      // SQL makes for an unknown feature. It must never read as `claimed`.
      return isClaimCode(code) ? code : 'no_plan';
    },

    async get(request: RevisionRequest): Promise<Explanation | null> {
      const found = env();
      if (!found) return null;

      const res = await doFetch(
        `${found.url}${TABLE}?select=question_id,lang,status,body,sources,audio_path,edited_by_teacher` +
          `&question_id=eq.${encodeURIComponent(request.questionId)}&lang=eq.${request.lang}`,
        { method: 'GET', headers: restHeaders({ accept: 'application/json' }), cache: 'no-store' },
      );
      if (!res.ok) return null;

      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows) || rows.length === 0) return null;

      const row = rows[0] as StoredRow;
      if (!isExplanationStatus(row.status)) return null;
      if (row.lang !== 'en' && row.lang !== 'hi') return null;

      return {
        questionId: request.questionId,
        lang: row.lang,
        status: row.status,
        body: readBody(row.body),
        sources: readSources(row.sources),
        audioPath: typeof row.audio_path === 'string' ? row.audio_path : null,
        editedByTeacher: row.edited_by_teacher === true,
      };
    },

    async question(questionId: string): Promise<QuestionForExplain | null> {
      const found = env();
      if (!found) return null;

      // NO `correct_idx` IN THIS SELECT (issue 30-exam-key-lock). The column
      // privilege is gone, so asking for it would make the whole request 403.
      // One request still, with the paper's exam name embedded, so the prompt
      // has the exam without a second round trip. RLS applies to both.
      const res = await doFetch(
        `${found.url}${QUESTIONS}?select=stem,options,teacher_explanation,topic_id,` +
          `papers(exams(name_en))&id=eq.${encodeURIComponent(questionId)}`,
        { method: 'GET', headers: restHeaders({ accept: 'application/json' }), cache: 'no-store' },
      );
      if (!res.ok) return null;

      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows) || rows.length === 0) return null;

      const row = rows[0] as StoredQuestion;
      const stem = typeof row.stem === 'string' ? row.stem.trim() : '';
      const options: QuestionOptions | null = readOptions(row.options);
      if (stem.length === 0 || !options) return null;

      // THE KEY, through the one route to it. An explanation of a question
      // whose right answer we do not know would be a guess, so no key means
      // NO EXPLANATION: the route turns this null into 404 and releases the
      // claim without charging the student. That is also what happens mid
      // exam, which is the point (F-E5).
      const correctIdx = await keyFor(questionId);
      if (correctIdx === null) return null;

      return {
        exam: readExamName(row.papers),
        // The topic NAME is a later slice; the id is not worth showing the
        // model, so this stays null rather than feeding it a uuid.
        topic: null,
        stem,
        options,
        teacherExplanation:
          typeof row.teacher_explanation === 'string' && row.teacher_explanation.trim().length > 0
            ? row.teacher_explanation
            : null,
        correctIdx,
      };
    },

    async finish(request: RevisionRequest, result: ExplainResult): Promise<void> {
      const saved = await rpc('finish_ai_explanation', {
        question_id: request.questionId,
        lang: request.lang,
        body: result.body,
        sources: result.sources,
        model: result.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        searches: result.searches,
      });
      // False means no row was `generating`: a teacher edited it, or the row
      // is gone. Either way the explanation the student just paid for is not
      // saved, so this is a failure the route must see.
      if (saved !== true) throw new Error('Supabase finish saved nothing');
    },

    async fail(request: RevisionRequest): Promise<void> {
      await rpc('fail_ai_explanation', {
        question_id: request.questionId,
        lang: request.lang,
      });
    },
  };
}

/** `papers(exams(name_en))` arrives as an object or a one-item array. */
function readExamName(papers: unknown): string | null {
  const paper = Array.isArray(papers) ? papers[0] : papers;
  if (typeof paper !== 'object' || paper === null) return null;
  const exams = (paper as Record<string, unknown>).exams;
  const exam = Array.isArray(exams) ? exams[0] : exams;
  if (typeof exam !== 'object' || exam === null) return null;
  const name = (exam as Record<string, unknown>).name_en;
  return typeof name === 'string' && name.trim().length > 0 ? name : null;
}
