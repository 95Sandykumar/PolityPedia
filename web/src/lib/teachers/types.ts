/**
 * The teachers contract for PolityPedia (issue 05-teacher-invite-approval).
 *
 * Teacher signup is invite only and an admin approves it (V1, F-A1).
 *
 * THE PRIVACY RULE (PRD F-A5): a student never sees the real name of a teacher
 * in alias mode. `PublicTeacher` is the shape of the `teachers_public` VIEW and
 * has no real-name field at all, so a page cannot show one by accident. The
 * enforcement itself is in SQL (`0005_teachers.sql`), not here.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite (web/CLAUDE.md).
 *
 * Two kinds of client, because a key must never reach the browser:
 * - `TeachersClient` runs on the server with the signed-in user's own access
 *   token, so Postgres RLS is the real gate.
 * - the browser clients call our own route handlers and never see a key.
 */

/** Does a student see the alias or the real name? */
export type IdentityMode = 'public' | 'alias';

/** A teacher waits as `pending` until an admin approves. */
export type TeacherStatus = 'pending' | 'approved';

export const IDENTITY_MODES: readonly IdentityMode[] = ['public', 'alias'];
export const TEACHER_STATUSES: readonly TeacherStatus[] = ['pending', 'approved'];

/** Longest invite code we accept. Matches the SQL check in 0005. */
export const MAX_INVITE_CODE_LENGTH = 64;

export function isIdentityMode(value: unknown): value is IdentityMode {
  return typeof value === 'string' && (IDENTITY_MODES as readonly string[]).includes(value);
}

export function isTeacherStatus(value: unknown): value is TeacherStatus {
  return typeof value === 'string' && (TEACHER_STATUSES as readonly string[]).includes(value);
}

/**
 * A teacher as a STUDENT may see them: one row of `public.teachers_public`.
 * In alias mode `displayName` is the alias and `avatarPath` the alias avatar.
 * There is deliberately no `realName` field.
 */
export interface PublicTeacher {
  userId: string;
  identityMode: IdentityMode;
  displayName: string;
  avatarPath: string | null;
  bioEn: string | null;
  bioHi: string | null;
  videosVisible: boolean;
}

/** A teacher waiting for approval, as the admin screen lists them. */
export interface PendingTeacher {
  userId: string;
  /** Visible to an admin only. RLS keeps it from every other role. */
  realName: string | null;
  alias: string | null;
  createdAt: string;
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface TeachersClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * Spend a single-use invite code and become a pending teacher.
   * Throws when the code is unknown or already used; the SQL function decides.
   */
  redeemInvite(code: string): Promise<void>;
  /** The caller's own status, or null when they have no teacher row. */
  myStatus(): Promise<TeacherStatus | null>;
  /** Teachers waiting for an admin. Empty list on any failure. */
  listPending(): Promise<PendingTeacher[]>;
  /** Approve one teacher. `approvedBy` is the admin's own user id. */
  approve(input: ApproveInput): Promise<void>;
  /** Approved teachers as a student sees them: the view, never the table. */
  listPublic(): Promise<PublicTeacher[]>;
  /**
   * One approved teacher for the portfolio page `/t/<id>`, or null when there
   * is no such row (issue 06-portfolio-follow). Reads the view, so a pending
   * teacher and an alias real name are both invisible here.
   */
  readPublic(userId: string): Promise<PublicTeacher | null>;
  /**
   * The same rows as `listPublic`, cut down to the given ids, for the Home tab
   * list of followed teachers (issue 06-portfolio-follow). An unknown or
   * unapproved id simply drops out.
   */
  listPublicByIds(userIds: readonly string[]): Promise<PublicTeacher[]>;
}

export interface ApproveInput {
  userId: string;
  approvedBy: string;
}

/** Browser side: the invite-code screen. Calls our own route. */
export interface TeacherSignupClient {
  redeem(code: string): Promise<void>;
}

/** Browser side: the admin approval screen. Calls our own route. */
export interface AdminTeachersClient {
  approve(userId: string): Promise<void>;
}
