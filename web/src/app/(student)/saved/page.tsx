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
 * The whole list is read in ONE request and handed down, so the two chips
 * filter what is already in the page and nothing waits for the network
 * (DESIGN.md section 10).
 */
import { SavedList } from '@/components/saved-list';
import { readStudentContext } from '@/lib/follows/student-page';
import { readSavedQuestions } from '@/lib/saved/student-page';
import { labels, plain } from '@/lib/i18n';

export default async function SavedPage() {
  const { session, configured, mode } = await readStudentContext();
  const items = configured ? await readSavedQuestions(session) : [];

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('nav.saved', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>

      {/* No keys, or nobody signed in: say so rather than draw an empty list
          that looks like "you have saved nothing". */}
      {configured ? (
        <SavedList items={items} mode={mode} />
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('saved.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
