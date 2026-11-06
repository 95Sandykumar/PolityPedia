/**
 * Home tab (issue 01-app-shell, filled in by 06-portfolio-follow, notices
 * added by 09-teacher-notifications).
 *
 * Two blocks:
 *  1. the teachers this student follows, the shortcut back to the people they
 *     study with. This is the page title, the one `h1`.
 *  2. the latest notices from those same teachers (V17, at most 5), so Home
 *     answers "anything new?" without a tap. An `h2` under the list, so the
 *     heading order stays 1 then 2 (DESIGN.md section 11).
 *
 * Read on the server: `follows` with the student's own token (so the
 * `follows_select_own` policy returns their rows only), then those ids through
 * the `teachers_public` VIEW, so an alias teacher is listed by their alias.
 *
 * The followed list is ALSO the filter for the notices: `readHomePosts` drops
 * any post whose author is not on it, so Home can never show a stranger's
 * notice even if a query came back wider than asked.
 *
 * Student-ui pass (2026-11-06): Home now reads as three sections. A "next exam"
 * card with the days left (the nearest future date across followed teachers),
 * "Your teachers" as a horizontal avatar strip, then the notices. The page
 * title is a plain "Home" h1, so the two section headings are both h2.
 */
import { HomeExamCard } from '@/components/home-exam-card';
import { PostList } from '@/components/post-list';
import { PageHeader } from '@/components/student-ui';
import { TeachersList } from '@/components/teachers-list';
import { readFollowedTeachers, readStudentContext } from '@/lib/follows/student-page';
import { readHomePosts } from '@/lib/posts/server-posts';
import type { FeedPost } from '@/lib/posts/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import { readHomeExam } from './_data/student-ui-data';

export default async function HomePage() {
  const { session, configured, mode } = await readStudentContext();
  const teachers: PublicTeacher[] = configured ? await readFollowedTeachers(session) : [];
  const [posts, homeExam]: [FeedPost[], Awaited<ReturnType<typeof readHomeExam>>] = configured
    ? await Promise.all([readHomePosts(session, teachers), readHomeExam(session, teachers)])
    : [[], null];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader titleKey="nav.home" mode={mode} />

      {homeExam ? (
        <HomeExamCard
          exam={homeExam.exam}
          teacherName={homeExam.teacherName}
          daysLeft={homeExam.daysLeft}
          mode={mode}
        />
      ) : null}

      <TeachersList
        teachers={teachers}
        titleKey="sui.yourTeachers"
        emptyKey="home.followingNone"
        mode={mode}
        configured={configured}
        variant="strip"
      />

      <PostList
        posts={posts}
        titleKey="posts.homeTitle"
        emptyKey="posts.homeNone"
        mode={mode}
        configured={configured}
        // Home mixes several teachers, so every notice names its author.
        showAuthor
      />
    </div>
  );
}
