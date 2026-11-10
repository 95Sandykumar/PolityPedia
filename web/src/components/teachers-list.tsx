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
 *
 * `failed` is the read-error half (issue 54b-read-errors-home-teachers): a
 * broken read used to reach here as an empty list and be announced as "You
 * follow nobody yet", which is a lie the student cannot act on.
 *
 * Issue 67-teachers-filter-and-free-badge adds two things to the Teachers tab:
 * the exam filter switch, and the "Free sample" badge.
 *
 * The switch is TWO LINKS, not a button and not a form. The list is read on
 * the server, so the only way to change it is to ask for another URL:
 * `/teachers` is the student's own exams, `/teachers?all=1` is everybody.
 * Links also mean back works and a filtered list can be shared.
 *
 * The badge comes from `hasFreeSample` and nothing else. That flag is decided
 * in SQL by the `teacher_cards` view (0050), which only counts a LIVE,
 * non-archived set with a non-archived free sample test, so a draft set can
 * never light the badge. This component does no arithmetic of its own.
 */
import { Check, ChevronRight, Gift, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { ReadError } from '@/components/read-error';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { CARD, EmptyState, Lines, SectionLink, SectionTitle } from '@/components/student-ui';
import { teacherPath } from '@/lib/follows/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { LucideIcon } from 'lucide-react';
import type { PublicTeacher, TeacherCard } from '@/lib/teachers/types';

/** Which view of the list the Teachers tab is showing. */
export type ExamFilter = 'mine' | 'all';

/**
 * Does this row carry the badge?
 *
 * `=== true` and nothing looser, the same rule the reader uses. A row with no
 * flag at all is the Home strip's `PublicTeacher`, and the one wrong answer
 * that matters here is telling a student a test is free when it is not.
 */
function hasFreeSample(teacher: PublicTeacher | TeacherCard): boolean {
  return 'hasFreeSample' in teacher && teacher.hasFreeSample === true;
}

/**
 * The small rounded label under a teacher's name. Icon plus a word, never
 * colour on its own (DESIGN.md section 3).
 */
function Pill({ Icon, text }: { Icon: LucideIcon; text: string }) {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2 text-xs leading-5 font-medium text-primary">
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
      {text}
    </span>
  );
}

/**
 * The two halves of the switch, in the order they are drawn. A table and not
 * two copies of the same JSX, so the pair cannot drift apart.
 */
const FILTER_LINKS: readonly { which: ExamFilter; href: string; key: MessageKey }[] = [
  { which: 'mine', href: '/teachers', key: 'teachers.myExams' },
  { which: 'all', href: '/teachers?all=1', key: 'teachers.showAll' },
];

export function TeachersList({
  teachers,
  titleKey,
  emptyKey,
  mode = DEFAULT_MODE,
  configured = true,
  variant = 'list',
  followedIds = [],
  failed = false,
  examFilter,
}: {
  teachers: readonly (PublicTeacher | TeacherCard)[];
  titleKey: MessageKey;
  emptyKey: MessageKey;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** `list` is the Teachers tab, `strip` is the Home avatar row. */
  variant?: 'list' | 'strip';
  /** Teacher ids the student follows, so the list can say "Following". */
  followedIds?: readonly string[];
  /**
   * True when the server read FAILED rather than came back empty
   * (issue 54b-read-errors-home-teachers). It wins over `teachers`: a
   * part-read list shown as if it were whole tells a student a teacher is not
   * there when they are.
   */
  failed?: boolean;
  /**
   * Which view the Teachers tab is showing, and the only thing that draws the
   * switch (issue 67-teachers-filter-and-free-badge). Left out on the Home
   * strip, which has no filter and no URL of its own.
   */
  examFilter?: ExamFilter;
}) {
  const strip = variant === 'strip';

  // Drawn in EVERY branch below, the empty and the failed one included: a
  // student whose exams match nobody has to be able to reach "Show all", and a
  // switch that disappears exactly when the list is empty is a dead end.
  const filterSwitch =
    examFilter === undefined ? null : (
      <nav aria-label={plain('teachers.filter', mode)} className="flex flex-wrap gap-2">
        {FILTER_LINKS.map(({ which, href, key }) => {
          const current = examFilter === which;
          return (
            <Link
              key={which}
              href={href}
              prefetch={false}
              // `aria-current`, never `disabled`: the current view stays a
              // link, so a reload and a shared URL both keep working.
              aria-current={current ? 'page' : undefined}
              className={`inline-flex min-h-12 items-center rounded-full border px-3 text-sm leading-6 font-medium transition-colors duration-100 ${
                current
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground'
              }`}
            >
              {plain(key, mode)}
            </Link>
          );
        })}
      </nav>
    );

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
        {filterSwitch}
        <p role="status" className="text-muted-foreground">
          {plain('teachers.notConfigured', mode)}
        </p>
      </section>
    );
  }

  // Checked BEFORE the empty state, never after: a broken read must not say
  // "You follow nobody yet".
  if (failed) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        {filterSwitch}
        <ReadError mode={mode} />
      </section>
    );
  }

  if (teachers.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        {filterSwitch}
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
      {filterSwitch}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {teachers.map((teacher) => {
          const bio = (mode === 'hi' ? teacher.bioHi : teacher.bioEn) ?? teacher.bioEn ?? teacher.bioHi;
          const free = hasFreeSample(teacher);
          const following = followed.has(teacher.userId);
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
                {free || following ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {free ? <Pill Icon={Gift} text={plain('teachers.freeSample', mode)} /> : null}
                    {following ? (
                      <Pill Icon={Check} text={plain('follow.following', mode)} />
                    ) : null}
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
