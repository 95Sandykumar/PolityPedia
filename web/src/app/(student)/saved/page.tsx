/**
 * The Saved tab: `/saved` (issue 14-saved-list).
 *
 * One of the five student tabs (DESIGN.md section 7, D1), and PRD F-E8: ONE
 * saved list with TWO tags, Wrong and Marked.
 *
 * The read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides: a student only ever
 * gets their own rows (`saved_questions_select_own`), and only live questions
 * of approved teachers come back with them (`questions_select_live`).
 *
 * The whole list is read in ONE request and handed down, so the two tabs
 * filter what is already in the page and nothing waits for the network
 * (DESIGN.md section 10).
 *
 * Student-ui pass (2026-11-06): a one-line hint under the title says what the
 * page is for.
 */
import { PageHeader } from '@/components/student-ui';
import { SavedList } from '@/components/saved-list';
import { readStudentContext } from '@/lib/follows/student-page';
import { readSavedQuestionsResult } from '@/lib/saved/student-page';
import { plain } from '@/lib/i18n';

export default async function SavedPage() {
  const { session, configured, mode } = await readStudentContext();
  // `ok` and `data` apart, so a read that FAILED can never reach the list as
  // an empty one (issue 54c-read-errors-saved-practice-media).
  const read = configured
    ? await readSavedQuestionsResult(session)
    : ({ ok: true, data: [] } as const);
  const items = read.ok ? read.data : [];

  return (
    <section className="flex flex-col gap-4">
      <PageHeader titleKey="nav.saved" hintKey="sui.savedHint" mode={mode} />

      {/* No keys, or nobody signed in: say so rather than draw an empty list
          that looks like "you have saved nothing". */}
      {configured ? (
        <SavedList items={items} failed={!read.ok} mode={mode} />
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('saved.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
