/**
 * Remove and restore for the four things a teacher can "delete"
 * (issue 45-keep-money-and-scores, migration 0041).
 *
 * A teacher never hard-deletes a mock set, a mock test, a past paper or a
 * batch any more. Postgres decides: `remove_*()` deletes the row only when no
 * purchase, access row, attempt or member depends on it, and archives it
 * otherwise. The answer is `'deleted'` or `'archived'`, and the screen tells
 * the teacher which one happened.
 *
 * Supabase sits behind the two interfaces at the bottom, so the tests fake it:
 * no real network call and no key anywhere in the suite (web/CLAUDE.md).
 */

export type ArchiveKind = 'mock-set' | 'mock-test' | 'paper' | 'batch';

export const ARCHIVE_KINDS: readonly ArchiveKind[] = [
  'mock-set',
  'mock-test',
  'paper',
  'batch',
];

export function isArchiveKind(value: unknown): value is ArchiveKind {
  return typeof value === 'string' && (ARCHIVE_KINDS as readonly string[]).includes(value);
}

/** What `remove_*()` answers. */
export type RemoveResult = 'deleted' | 'archived';

export function isRemoveResult(value: unknown): value is RemoveResult {
  return value === 'deleted' || value === 'archived';
}

/** How long an archived row can be brought back. Same number as 0041. */
export const RESTORE_WINDOW_DAYS = 30;

/** The Postgres function and its parameter name for each kind. */
export const ARCHIVE_RPC: Record<ArchiveKind, { remove: string; restore: string; param: string }> =
  {
    'mock-set': { remove: 'remove_mock_set', restore: 'restore_mock_set', param: 'for_set' },
    'mock-test': { remove: 'remove_mock_test', restore: 'restore_mock_test', param: 'for_test' },
    paper: { remove: 'remove_paper', restore: 'restore_paper', param: 'for_paper' },
    batch: { remove: 'remove_batch', restore: 'restore_batch', param: 'for_batch' },
  };

const BASE: Record<ArchiveKind, string> = {
  'mock-set': '/api/teacher/mock-sets',
  'mock-test': '/api/teacher/mock-tests',
  paper: '/api/teacher/papers',
  batch: '/api/teacher/batches',
};

/** Our own route for one object. DELETE removes it. */
export function archivePath(kind: ArchiveKind, id: string): string {
  return `${BASE[kind]}/${encodeURIComponent(id)}`;
}

/** Our own route that brings an archived object back. POST. */
export function restorePath(kind: ArchiveKind, id: string): string {
  return `${archivePath(kind, id)}/restore`;
}

/**
 * Codes the browser client throws and the screens turn into one line. Never a
 * server message.
 */
export type ArchiveErrorCode = 'not-found' | 'window-over';

/** Server side. Carries the caller's own access token, so Postgres decides. */
export interface ArchiveClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /**
   * `remove_*()`. Throws an error named `ArchiveNotFound` for a row that is
   * not the caller's (or does not exist).
   */
  remove(kind: ArchiveKind, id: string): Promise<RemoveResult>;
  /**
   * `restore_*()`. Throws `ArchiveNotFound` the same way, and
   * `RestoreWindowOver` after 30 days.
   */
  restore(kind: ArchiveKind, id: string): Promise<void>;
}

/** Browser side: our own routes, no key. */
export interface BrowserArchiveClient {
  remove(kind: ArchiveKind, id: string): Promise<RemoveResult>;
  restore(kind: ArchiveKind, id: string): Promise<void>;
}
