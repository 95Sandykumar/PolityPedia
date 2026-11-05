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
 * Videos and dates come later (issues 07 and 08).
 */
import { PostList } from '@/components/post-list';
import { TeachersList } from '@/components/teachers-list';
import { readFollowedTeachers, readStudentContext } from '@/lib/follows/student-page';
import { readHomePosts } from '@/lib/posts/server-posts';
import type { FeedPost } from '@/lib/posts/types';
import type { PublicTeacher } from '@/lib/teachers/types';

export default async function HomePage() {
  const { session, configured, mode } = await readStudentContext();
  const teachers: PublicTeacher[] = configured ? await readFollowedTeachers(session) : [];
  const posts: FeedPost[] = configured ? await readHomePosts(session, teachers) : [];

  return (
    <div className="flex flex-col gap-6">
      <TeachersList
        teachers={teachers}
        titleKey="home.following"
        emptyKey="home.followingNone"
        mode={mode}
        configured={configured}
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
