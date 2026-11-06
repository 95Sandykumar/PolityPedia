/**
 * Remembering a claim secret, for the database tests (issue
 * 37-ai-claim-secret).
 *
 * `claim_ai_explanation()` and `claim_explanation_audio()` return
 * `{code, secret}`, and `finish_*` / `fail_*` need that secret as well as
 * `claimed_by`. Postgres keeps only a sha256 of it, so there is nothing to
 * read back out: the ONE caller that was told it has to hold on to it.
 *
 * Our route holds it in a local variable for the length of one model call
 * (`src/lib/ai/revision-route.ts`). This map does the same for the test
 * helpers, so every assertion written before the secret existed still reads
 * the way it did.
 *
 * Keyed on the CALLER as well as the row, so a claimant whose claim was taken
 * over keeps presenting their own, now dead, secret. That is exactly what a
 * late reply from a timed-out serverless function does, and refusing it is
 * the point.
 */

/** Which claim a secret belongs to: the explanation text, or its narration. */
export type ClaimKind = 'text' | 'audio';

const claimSecrets = new Map<string, string>();

function secretKey(
  kind: ClaimKind,
  userId: string,
  questionId: string,
  lang: string,
): string {
  return `${kind}|${userId}|${questionId}|${lang}`;
}

/** Forget everything. Call it in `beforeEach`, beside the row deletes. */
export function clearClaimSecrets(): void {
  claimSecrets.clear();
}

/** The secret this caller was last handed for this claim, or null. */
export function heldSecret(
  kind: ClaimKind,
  userId: string,
  questionId: string,
  lang: string,
): string | null {
  return claimSecrets.get(secretKey(kind, userId, questionId, lang)) ?? null;
}

/**
 * Read a claim's `{code, secret}` reply, keeping the secret if there is one,
 * and give back just the word so the caller reads like the old helper.
 */
export function readClaim(
  kind: ClaimKind,
  userId: string,
  questionId: string,
  lang: string,
  value: unknown,
): string {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw.secret === 'string') {
    claimSecrets.set(secretKey(kind, userId, questionId, lang), raw.secret);
  }
  return typeof raw.code === 'string' ? raw.code : '';
}
