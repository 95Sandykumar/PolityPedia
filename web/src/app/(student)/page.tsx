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
 *
 * Issue 63-public-landing: NOBODY SIGNED IN is a different screen, not an
 * empty Home. A visitor used to see "Teachers are not set up yet" and read it
 * as "this app is broken" (persona-1 gap 3), so a logged-out `/` now returns
 * the landing and NOT ONE student read runs.
 *
 * Issue 54b-read-errors-home-teachers: both blocks now read a RESULT, so a
 * broken read shows the shared error state with Retry instead of the empty
 * state. Home was the worst place for the old behaviour: a student who follows
 * three teachers was told they follow nobody.
 */
import { HomeExamCard } from '@/components/home-exam-card';
import { PostList } from '@/components/post-list';
import { PublicLanding } from '@/components/public-landing';
import { PageHeader } from '@/components/student-ui';
import { TeachersList } from '@/components/teachers-list';
import { readFollowedTeachersResult, readStudentContext } from '@/lib/follows/student-page';
import { readHomePostsResult } from '@/lib/posts/server-posts';
import type { FeedPost } from '@/lib/posts/types';
import { readOk, type ReadResult } from '@/lib/read-result';
import type { PublicTeacher } from '@/lib/teachers/types';
import { readHomeExam } from './_data/student-ui-data';

export default async function HomePage() {
  const { session, configured, mode } = await readStudentContext();

  // Logged out: the landing, and we return BEFORE any read. Nothing a signed-in
  // student owns is fetched, so nothing of theirs can be shown or cached here
  // (design constraint C).
  if (!session) return <PublicLanding mode={mode} />;

  // `ok` and `data` apart, so a read that FAILED can never reach a list as an
  // empty one (issue 54b-read-errors-home-teachers).
  const teachersRead: ReadResult<PublicTeacher[]> = configured
    ? await readFollowedTeachersResult(session)
    : readOk<PublicTeacher[]>([]);
  const teachers: PublicTeacher[] = teachersRead.ok ? teachersRead.data : [];

  const [postsRead, homeExam]: [
    ReadResult<FeedPost[]>,
    Awaited<ReturnType<typeof readHomeExam>>,
  ] = configured
    ? await Promise.all([readHomePostsResult(session, teachers), readHomeExam(session, teachers)])
    : [readOk<FeedPost[]>([]), null];
  const posts: FeedPost[] = postsRead.ok ? postsRead.data : [];

  // The followed list is the notices' FILTER as well as the teacher strip. So
  // if that read broke, the notices are untrustworthy too even when their own
  // query answered 200: the feed could be missing a whole teacher.
  const postsFailed = !teachersRead.ok || !postsRead.ok;

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
        failed={!teachersRead.ok}
      />

      <PostList
        posts={posts}
        titleKey="posts.homeTitle"
        emptyKey="posts.homeNone"
        mode={mode}
        configured={configured}
        failed={postsFailed}
        // Home mixes several teachers, so every notice names its author.
        showAuthor
      />
    </div>
  );
}
