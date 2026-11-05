/**
 * A list of teachers, each row a link to that teacher's portfolio
 * (issue 06-portfolio-follow).
 *
 * One component, two places, because the row is identical in both:
 * - the Teachers tab: every approved teacher.
 * - the Home tab: only the teachers this student follows.
 * The caller passes the rows plus the title and empty-state keys.
 *
 * PRIVACY: the rows are `PublicTeacher`, the shape of the `teachers_public`
 * view, which has no real-name field at all. An alias teacher is listed by
 * their alias and this component could not show a real name if it tried.
 *
 * A server component on purpose: the rows are read on the server with the
 * student's own token, so no key and no list fetch reaches the browser.
 */
import Link from 'next/link';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { teacherPath } from '@/lib/follows/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

export function TeachersList({
  teachers,
  titleKey,
  emptyKey,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  teachers: readonly PublicTeacher[];
  titleKey: MessageKey;
  emptyKey: MessageKey;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels(titleKey, mode).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </h1>
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('teachers.notConfigured', mode)}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {title}

      {teachers.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain(emptyKey, mode)}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {teachers.map((teacher) => (
            <li key={teacher.userId}>
              <Link
                href={teacherPath(teacher.userId)}
                prefetch={false}
                className="flex min-h-12 items-center gap-3 rounded-[10px] border border-border bg-card p-3 transition-colors duration-100"
              >
                <TeacherAvatar
                  displayName={teacher.displayName}
                  avatarPath={teacher.avatarPath}
                  size={40}
                  decorative
                />
                <span className="text-base font-medium">{teacher.displayName}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
