/**
 * Mock test player `/t/<teacherId>/mocks/<testId>/play`
 * (route opened by issue 16-set-access-mock-list).
 *
 * A real page with a real URL, so the Attempt and Review buttons on the mock
 * list have somewhere to go and Back works (DESIGN.md section 7). The PLAYER
 * is issues 17-practice-mode and 18-exam-mode; this slice only opens the
 * route, so it shows the title plus "Coming soon".
 *
 * `mockPlayerPath()` in `@/lib/set-access/types` builds the link, with the
 * chosen mode and topic in the query, so those two slices read a choice the
 * student already made rather than guessing one.
 */
import { PlaceholderPage } from '@/components/placeholder-page';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function MockPlayerPage() {
  const { mode } = await readStudentContext();
  return <PlaceholderPage titleKey="tile.mocks" mode={mode} />;
}
