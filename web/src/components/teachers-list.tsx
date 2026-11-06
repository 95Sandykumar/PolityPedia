/**
 * A list of teachers, each row a link to that teacher's portfolio
 * (issue 06-portfolio-follow).
 *
 * One component, two places, because the row is the same in both:
 * - the Teachers tab: every approved teacher, as cards (`variant="list"`).
 * - the Home tab: only the teachers this student follows, as a horizontal
 *   avatar strip (`variant="strip"`, student-ui pass 2026-11-06). The caller
 *   passes the rows plus the title and empty-state keys.
 *
 * PRIVACY: the rows are `PublicTeacher`, the shape of the `teachers_public`
 * view, which has no real-name field at all. An alias teacher is listed by
 * their alias and this component could not show a real name if it tried.
 *
 * A server component on purpose: the rows are read on the server with the
 * student's own token, so no key and no list fetch reaches the browser.
 *
 * The link's accessible name is the teacher's name and nothing else: the bio
 * and the Following pill sit beside it, and the whole card is tappable through
 * a stretched pseudo element on the name link.
 */
import { Check, ChevronRight, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { CARD, EmptyState, Lines, SectionLink, SectionTitle } from '@/components/student-ui';
import { teacherPath } from '@/lib/follows/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

export function TeachersList({
  teachers,
  titleKey,
  emptyKey,
  mode = DEFAULT_MODE,
  configured = true,
  variant = 'list',
  followedIds = [],
}: {
  teachers: readonly PublicTeacher[];
  titleKey: MessageKey;
  emptyKey: MessageKey;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** `list` is the Teachers tab, `strip` is the Home avatar row. */
  variant?: 'list' | 'strip';
  /** Teacher ids the student follows, so the list can say "Following". */
  followedIds?: readonly string[];
}) {
  const strip = variant === 'strip';

  const title = strip ? (
    <SectionTitle
      Icon={Users}
      titleKey={titleKey}
      mode={mode}
      count={configured ? teachers.length : undefined}
      action={
        teachers.length > 0 ? (
          <SectionLink href="/teachers">{plain('sui.seeAll', mode)}</SectionLink>
        ) : null
      }
    />
  ) : (
    <h1 className="text-[22px] leading-8 font-bold">
      <Lines keyName={titleKey} mode={mode} />
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

  if (teachers.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <EmptyState
          Icon={Search}
          text={plain(emptyKey, mode)}
          hint={strip ? plain('sui.findTeachersHint', mode) : undefined}
          action={strip ? { href: '/teachers', label: plain('sui.findTeachers', mode) } : undefined}
        />
      </section>
    );
  }

  if (strip) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        {/* Scrolls inside its own box, never the page (DESIGN.md section 5).
            The negative margin lets the row run to the screen edge. */}
        <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {teachers.map((teacher) => (
            <li key={teacher.userId} className="w-[84px] shrink-0 snap-start">
              <Link
                href={teacherPath(teacher.userId)}
                prefetch={false}
                className="flex min-h-12 flex-col items-center gap-2 rounded-[10px] py-1 text-center"
              >
                <TeacherAvatar
                  displayName={teacher.displayName}
                  avatarPath={teacher.avatarPath}
                  size={64}
                  decorative
                />
                <span className="line-clamp-2 text-sm leading-5 font-medium">
                  {teacher.displayName}
                </span>
              </Link>
            </li>
          ))}
          <li className="w-[84px] shrink-0 snap-start">
            <Link
              href="/teachers"
              prefetch={false}
              className="flex min-h-12 flex-col items-center gap-2 rounded-[10px] py-1 text-center"
            >
              <span
                aria-hidden="true"
                className="flex size-16 items-center justify-center rounded-full border border-dashed border-primary text-primary"
              >
                <Search className="size-6" strokeWidth={2} />
              </span>
              <span className="text-sm leading-5 font-medium text-primary">
                <Lines keyName="sui.findTeachers" mode={mode} />
              </span>
            </Link>
          </li>
        </ul>
      </section>
    );
  }

  const followed = new Set(followedIds);

  return (
    <section className="flex flex-col gap-3">
      {title}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {teachers.map((teacher) => {
          const bio = (mode === 'hi' ? teacher.bioHi : teacher.bioEn) ?? teacher.bioEn ?? teacher.bioHi;
          return (
            <li
              key={teacher.userId}
              className={`${CARD} relative flex items-center gap-3 p-3 transition-colors duration-100 focus-within:border-primary`}
            >
              <TeacherAvatar
                displayName={teacher.displayName}
                avatarPath={teacher.avatarPath}
                size={56}
                decorative
              />
              <div className="flex min-w-0 grow flex-col gap-1">
                <Link
                  href={teacherPath(teacher.userId)}
                  prefetch={false}
                  className="text-base leading-6 font-bold after:absolute after:inset-0 after:content-['']"
                >
                  {teacher.displayName}
                </Link>
                {bio ? (
                  <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{bio}</p>
                ) : null}
                {followed.has(teacher.userId) ? (
                  <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2 text-xs leading-5 font-medium text-primary">
                    <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
                    {plain('follow.following', mode)}
                  </span>
                ) : null}
              </div>
              <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
