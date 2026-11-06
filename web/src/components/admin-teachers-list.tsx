'use client';

/**
 * Admin screen: approve the teachers who are waiting
 * (issue 05-teacher-invite-approval, laid out again in the admin-ui pass).
 *
 * Definition of done, second half. An admin is the only role that may set
 * `teachers.status`, and that is enforced by the `teachers_admin_all` policy
 * plus the `teachers_block_admin_fields` trigger inside Postgres (V19). This
 * screen is convenience, not permission.
 *
 * The rows are read on the server and passed in, so this component holds no
 * key and makes no read of its own. The client is a prop so the test can
 * inject a fake: no real network call and no real key (web/CLAUDE.md).
 *
 * An admin may see a real name; a student never can, because a student has no
 * select policy on `teachers` at all.
 *
 * Source: hand-built from DESIGN.md tokens (cards, chips, Lucide icons).
 */
import { useMemo, useState } from 'react';
import { Check, Clock, UserCheck, UserRound } from 'lucide-react';
import { createBrowserAdminTeachersClient } from '@/lib/teachers/browser-teachers-client';
import type { AdminTeachersClient, PendingTeacher } from '@/lib/teachers/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';
import {
  Banner,
  CARD,
  Chip,
  EmptyState,
  Lines,
  PageHeader,
  PRIMARY_BUTTON,
} from '@/components/admin-ui';

/** `YYYY-MM-DD` in UTC, or the raw text when it is not a date. */
function appliedDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
}

export function AdminTeachersList({
  teachers,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  teachers: readonly PendingTeacher[];
  client?: AdminTeachersClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserAdminTeachersClient(), []);
  const admin = client ?? fallback;

  /** Rows already approved in this session, so the list shrinks as you work. */
  const [approved, setApproved] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastApproved, setLastApproved] = useState(false);

  const waiting = teachers.filter((teacher) => !approved.includes(teacher.userId));

  const title = <Lines keyName="adminTeachers.title" mode={mode} />;

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Banner tone="info" role="status">
          {plain('adminTeachers.notConfigured', mode)}
        </Banner>
      </section>
    );
  }

  async function approve(userId: string) {
    if (busy) return;
    setBusy(userId);
    setFailed(false);
    setLastApproved(false);
    try {
      await admin.approve(userId);
      setApproved((old) => [...old, userId]);
      setLastApproved(true);
    } catch {
      // Fixed message only, and the row stays: nothing changed in the DB.
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title={title}
        hint={plain('adminTeachers.hint', mode)}
        aside={
          waiting.length > 0 ? (
            <Chip tone="warn" icon={<Clock aria-hidden="true" className="size-3.5" />}>
              <span className="tabular-nums">{waiting.length}</span>{' '}
              {plain('adminTeachers.waitingCount', mode)}
            </Chip>
          ) : null
        }
      />

      {failed ? (
        <Banner tone="error" role="alert">
          {plain('adminTeachers.failed', mode)}
        </Banner>
      ) : null}

      {lastApproved ? (
        <Banner tone="success" role="status">
          {plain('adminTeachers.approved', mode)}
        </Banner>
      ) : null}

      {waiting.length === 0 ? (
        <EmptyState icon={<UserCheck className="size-8" />}>
          {plain('adminTeachers.none', mode)}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {waiting.map((teacher) => {
            const name = teacher.realName ?? teacher.alias;
            const showAlias = teacher.alias && teacher.alias !== name;
            return (
              <li key={teacher.userId} className={CARD + ' flex flex-col gap-3 p-3'}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                  >
                    <UserRound className="size-5" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {name ? (
                        <span className="min-w-0 text-lg leading-6 font-bold break-words">
                          {name}
                        </span>
                      ) : null}
                      <Chip
                        tone="warn"
                        icon={<Clock aria-hidden="true" className="size-3.5" />}
                      >
                        {plain('adminTeachers.statusPending', mode)}
                      </Chip>
                    </div>
                    {showAlias ? (
                      <span className="text-sm text-muted-foreground">{teacher.alias}</span>
                    ) : null}
                  </div>
                </div>

                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{plain('adminTeachers.userId', mode)}</dt>
                  <dd className="font-mono text-xs break-all text-muted-foreground">
                    {teacher.userId}
                  </dd>
                  <dt className="text-muted-foreground">
                    {plain('adminTeachers.appliedOn', mode)}
                  </dt>
                  <dd className="tabular-nums">{appliedDay(teacher.createdAt)}</dd>
                </dl>

                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void approve(teacher.userId)}
                  aria-label={plain('adminTeachers.approve', mode)}
                  className={PRIMARY_BUTTON + ' sm:w-full'}
                >
                  <Check aria-hidden="true" className="size-5" />
                  {plain(
                    busy === teacher.userId ? 'adminTeachers.approving' : 'adminTeachers.approve',
                    mode,
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
