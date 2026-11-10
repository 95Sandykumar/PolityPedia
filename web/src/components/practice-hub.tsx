/**
 * The Practice tab (student-ui pass, 2026-11-06).
 *
 * This tab used to read "Coming soon". Everything a student practises already
 * lives under a teacher (their mock tests and their past papers), so the tab is
 * the shortcut: one card per FOLLOWED teacher with two big buttons, plus a row
 * for the saved questions. No new data and no new route: every button is a link
 * to a page that already exists.
 *
 * A server component: no state, nothing ships to the browser.
 */
import { Bookmark, ChevronRight, FileText, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { ReadError } from '@/components/read-error';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { CARD, EmptyState, IconChip, PageHeader, SectionTitle } from '@/components/student-ui';
import { tilePath, teacherPath } from '@/lib/follows/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

const BUTTON =
  'flex min-h-14 items-center justify-center gap-2 rounded-[10px] border border-primary bg-card px-3 text-base font-medium text-primary transition-colors duration-100';

export function PracticeHub({
  teachers,
  mode = DEFAULT_MODE,
  configured = true,
  failed = false,
}: {
  teachers: readonly PublicTeacher[];
  mode?: LangMode;
  /** False when the Supabase env vars are missing, or nobody is signed in. */
  configured?: boolean;
  /**
   * True when the followed-teachers read FAILED rather than came back empty
   * (issue 54c-read-errors-saved-practice-media). It wins over `teachers`: a
   * part-read hub sends a student to Teachers to find somebody they already
   * follow.
   */
  failed?: boolean;
}) {
  return (
    <section className="flex flex-col gap-6">
      <PageHeader titleKey="nav.practice" hintKey="sui.practiceHint" mode={mode} />

      {!configured ? (
        <p role="status" className="text-muted-foreground">
          {plain('player.notConfigured', mode)}
        </p>
      ) : failed ? (
        // BEFORE the empty state, never after: a broken read must not say
        // "You follow nobody yet".
        <ReadError mode={mode} />
      ) : teachers.length === 0 ? (
        <EmptyState
          Icon={ListChecks}
          text={plain('sui.practiceNone', mode)}
          action={{ href: '/teachers', label: plain('sui.findTeachers', mode) }}
        />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {teachers.map((teacher) => (
              <li key={teacher.userId} className={`${CARD} flex flex-col gap-3 p-3`}>
                <div className="flex items-center gap-3">
                  <TeacherAvatar
                    displayName={teacher.displayName}
                    avatarPath={teacher.avatarPath}
                    size={48}
                    decorative
                  />
                  <Link
                    href={teacherPath(teacher.userId)}
                    prefetch={false}
                    className="min-w-0 grow text-base leading-6 font-bold"
                  >
                    {teacher.displayName}
                  </Link>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Link href={tilePath(teacher.userId, 'mocks')} prefetch={false} className={BUTTON}>
                    <ListChecks aria-hidden="true" className="size-5" strokeWidth={2} />
                    {plain('sui.practiceMocks', mode)}
                  </Link>
                  <Link href={tilePath(teacher.userId, 'papers')} prefetch={false} className={BUTTON}>
                    <FileText aria-hidden="true" className="size-5" strokeWidth={2} />
                    {plain('sui.practicePapers', mode)}
                  </Link>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-3">
            <SectionTitle Icon={Bookmark} titleKey="sui.practiceSaved" mode={mode} />
            <Link
              href="/saved"
              prefetch={false}
              className={`${CARD} flex min-h-14 items-center gap-3 p-3 transition-colors duration-100`}
            >
              <IconChip Icon={Bookmark} />
              <span className="grow text-base leading-6 font-medium">
                {plain('saved.wrong', mode)} / {plain('saved.marked', mode)}
              </span>
              <ChevronRight aria-hidden="true" className="size-5 text-muted-foreground" />
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
