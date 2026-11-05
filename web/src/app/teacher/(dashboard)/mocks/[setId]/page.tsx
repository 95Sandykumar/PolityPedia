/**
 * One mock set: reprice it, add tests, add questions, publish
 * (issue 15-mock-sets-authoring).
 *
 * Every read runs HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. A set that is not the caller's own comes back null and
 * the screen says "Mock set not found", which is also what a stranger gets.
 *
 * The questions are read here, not in the client component, for the same
 * reason the review screen does it: there is ONE place that knows how to read
 * a question, and the publish gate needs all of them to answer "is anything
 * still unchecked".
 */
import { MockSetEditor } from '@/components/mock-set-editor';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMockSet, readMockSetData, readMyShare } from '@/lib/mocks/teacher-page';

export default async function TeacherMockSetPage({
  params,
}: {
  params: Promise<{ setId: string }>;
}) {
  const { setId } = await params;
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  if (!configured) {
    return <MockSetEditor set={null} sharePct={50} mode={mode} configured={false} />;
  }

  // Fails soft: a Supabase hiccup shows "Mock set not found", never a 500.
  const set = await readMockSet(session, setId);

  const [{ tests, questions }, sharePct] = await Promise.all([
    set ? readMockSetData(session, set.id) : Promise.resolve({ tests: [], questions: [] }),
    readMyShare(session),
  ]);

  return (
    <MockSetEditor
      set={set}
      tests={tests}
      questions={questions}
      sharePct={sharePct}
      mode={mode}
    />
  );
}
