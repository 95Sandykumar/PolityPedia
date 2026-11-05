/**
 * Every reply code the revision route can answer with, and the label a
 * student sees for it (issue 22-revision-api).
 *
 * This table is why the route may answer with a bare code: the code is not
 * the message. The UI (issue 23) looks the code up here and renders the
 * label in the student's language, so no reply can reach a screen as an
 * English-only string from a route handler.
 *
 * DESIGN.md section 9: an error says what went wrong and the fix.
 */
import type { MessageKey } from '@/lib/i18n';
import type { RevisionError } from './revision-route';

export const REVISION_ERROR_LABEL: Record<RevisionError, MessageKey> = {
  rate: 'revision.rate',
  sign_in: 'revision.signIn',
  // A bad body is our bug, not the student's. They see the same "try again"
  // as a model failure, because there is nothing for them to fix.
  bad_request: 'revision.failed',
  not_configured: 'revision.notConfigured',
  no_plan: 'revision.noPlan',
  not_found: 'revision.notFound',
  limit: 'revision.limit',
  ai_failed: 'revision.failed',
};
