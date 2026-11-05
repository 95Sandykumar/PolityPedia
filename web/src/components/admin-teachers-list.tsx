'use client';

/**
 * Admin screen: approve the teachers who are waiting
 * (issue 05-teacher-invite-approval).
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
 */
import { useMemo, useState } from 'react';
import { createBrowserAdminTeachersClient } from '@/lib/teachers/browser-teachers-client';
import type { AdminTeachersClient, PendingTeacher } from '@/lib/teachers/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const OUTLINE_BUTTON =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 disabled:opacity-60';

function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </>
  );
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

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      <Lines keyName="adminTeachers.title" mode={mode} />
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('adminTeachers.notConfigured', mode)}
        </p>
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
    <section className="flex flex-col gap-3">
      {title}

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('adminTeachers.failed', mode)}
        </p>
      ) : null}

      {lastApproved ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain('adminTeachers.approved', mode)}
        </p>
      ) : null}

      {waiting.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain('adminTeachers.none', mode)}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {waiting.map((teacher) => (
            <li
              key={teacher.userId}
              className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3"
            >
              <div className="flex flex-col gap-1">
                {teacher.realName ? (
                  <span className="text-base font-medium">{teacher.realName}</span>
                ) : null}
                {teacher.alias ? (
                  <span className="text-sm text-muted-foreground">{teacher.alias}</span>
                ) : null}
                <span className="font-mono text-xs text-muted-foreground">{teacher.userId}</span>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void approve(teacher.userId)}
                aria-label={plain('adminTeachers.approve', mode)}
                className={OUTLINE_BUTTON}
              >
                {plain(
                  busy === teacher.userId ? 'adminTeachers.approving' : 'adminTeachers.approve',
                  mode,
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
