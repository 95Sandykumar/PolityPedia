/**
 * Home tab (issue 01-app-shell, filled in by 06-portfolio-follow).
 *
 * The teachers this student follows, newest first, so Home is the shortcut
 * back to the people they study with. Videos, dates and posts come later
 * (issues 07 to 09); this slice puts the list there.
 *
 * Read on the server: `follows` with the student's own token (so the
 * `follows_select_own` policy returns their rows only), then those ids through
 * the `teachers_public` VIEW, so an alias teacher is listed by their alias.
 */
import { TeachersList } from '@/components/teachers-list';
import { readFollowedTeachers, readStudentContext } from '@/lib/follows/student-page';
import type { PublicTeacher } from '@/lib/teachers/types';

export default async function HomePage() {
  const { session, configured, mode } = await readStudentContext();
  const teachers: PublicTeacher[] = configured ? await readFollowedTeachers(session) : [];

  return (
    <TeachersList
      teachers={teachers}
      titleKey="home.following"
      emptyKey="home.followingNone"
      mode={mode}
      configured={configured}
    />
  );
}
