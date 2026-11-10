/**
 * Past papers, grouped Exam > Year > Month, with a download button per PDF
 * (issue 10-papers-upload-browse).
 *
 * One component for both sides of the slice: the student's
 * `/t/<teacherId>/papers` page and the teacher's own Papers screen. The only
 * difference is `showStatus`, the Draft / Live badge, which a student never
 * sees because a student never gets a draft row at all (`papers_select_live`).
 *
 * A server component: there is no state here, so nothing of this ships to the
 * browser (DESIGN.md section 10, 150 KB budget).
 *
 * The download link points at OUR route, never at Supabase: the signed URL is
 * minted on the server, for a paper the policy already allowed, and it dies a
 * minute later.
 */
import { Check, FileText, ListChecks, Play } from 'lucide-react';
import { ReadError } from '@/components/read-error';
import { EmptyState, IconChip } from '@/components/student-ui';
import Link from 'next/link';
import { playerPath } from '@/lib/attempts/types';
import type { Exam } from '@/lib/exams/types';
import type { PaperProgress } from '@/lib/papers/progress';
import {
  groupPapers,
  monthLabels,
  paperDownloadPath,
  type Paper,
  type PaperKind,
} from '@/lib/papers/types';
import { paperReviewPath } from '@/lib/questions/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** The file-type chip on a PDF button (student-ui pass). */
const CHIP =
  'rounded-[6px] border border-current px-1.5 text-xs leading-4 font-bold tracking-wide';

/** 48 px tall, the touch-target floor (DESIGN.md section 5). */
const DOWNLOAD =
  'inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-primary bg-card px-3 text-base font-medium text-primary transition-colors duration-100';
const PRACTICE =
  'inline-flex min-h-12 items-center gap-2 rounded-[10px] bg-primary px-4 text-base font-medium text-primary-foreground transition-colors duration-100';

const BADGE =
  'rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground';

/** The question count and the Done tick (issue 66-papers-question-count). */
const NOTE = 'inline-flex items-center gap-1 text-sm font-medium text-muted-foreground';

export function PapersList({
  papers,
  exams,
  mode = DEFAULT_MODE,
  showStatus = false,
  showReview = false,
  playTeacherId,
  progress,
  failed = false,
}: {
  papers: readonly Paper[];
  /** The catalogue, for the exam headings and their order. */
  exams: readonly Exam[];
  mode?: LangMode;
  /** True on the teacher's own screen: shows the Draft / Live badge. */
  showStatus?: boolean;
  /**
   * Set on the student's browse page: adds the Practice link, which opens the
   * question player (issue 13-question-player). The teacher's own screen
   * leaves it out, because a draft paper has nothing live to practise.
   */
  playTeacherId?: string;
  /**
   * The student's progress per paper (issue 66-papers-question-count). A paper
   * with no entry has unknown progress: no count, no tick, Practice kept.
   */
  progress?: ReadonlyMap<string, PaperProgress>;
  /**
   * True on the teacher's own screen: adds the Review link, which opens the
   * check-and-publish screen (issue 11-ingest-job-review-publish).
   */
  showReview?: boolean;
  /**
   * True when the server read FAILED rather than came back empty
   * (issue 54a-read-error-core). It wins over `papers`: a part-read list shown
   * as if it were whole tells a student a paper does not exist when it does.
   */
  failed?: boolean;
}) {
  // Checked BEFORE the empty state, never after: a broken read must not say
  // "No papers yet".
  if (failed) {
    return <ReadError mode={mode} />;
  }

  const groups = groupPapers(papers, exams);

  if (groups.length === 0) {
    return <EmptyState Icon={FileText} text={plain('papers.none', mode)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        // Same shape as `examLabels()`, but a paper whose exam is missing from
        // the catalogue has no name at all, and then there is no heading.
        const examLines =
          mode === 'both'
            ? [group.nameEn, group.nameHi]
            : [mode === 'hi' ? group.nameHi : group.nameEn];
        const shown = examLines.filter((line) => line.length > 0);

        return (
          <section key={group.examId} className="flex flex-col gap-3">
            {shown.length > 0 ? (
              <div className="flex items-center gap-2">
                <IconChip Icon={FileText} />
                <h2 className="text-[18px] leading-7 font-bold">
                  {shown.map((line, index) => (
                    <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                      {line}
                    </span>
                  ))}
                </h2>
              </div>
            ) : null}

            {group.years.map((year) => (
              <div key={year.year} className="flex flex-col gap-2">
                <h3 className="flex items-center gap-3 text-base leading-6 font-bold tabular-nums after:h-px after:grow after:bg-border after:content-['']">
                  {year.year}
                </h3>

                {year.months.map((month) => (
                  <div key={String(month.month)} className="flex flex-col gap-2">
                    {/* No heading for "year only": there is no month to name. */}
                    {month.month !== null ? (
                      <h4 className="text-sm leading-5 font-medium text-muted-foreground">
                        {monthLabels(month.month, mode).map((line, index) => (
                          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                            {line}
                          </span>
                        ))}
                      </h4>
                    ) : null}

                    <ul className="flex flex-col gap-2">
                      {month.papers.map((paper) => (
                        <li
                          key={paper.id}
                          className={`${CARD} flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-base leading-6 font-bold">{paper.label}</span>
                            {showStatus ? (
                              <span className={BADGE}>
                                {plain(
                                  paper.status === 'live' ? 'papers.live' : 'papers.draft',
                                  mode,
                                )}
                              </span>
                            ) : null}
                          </span>

                          <span className="flex flex-wrap gap-2">
                            {/* Student side only: open the question player
                                (issue 13-question-player). */}
                            {playTeacherId ? (
                              <PracticeCell
                                paper={paper}
                                teacherId={playTeacherId}
                                known={progress?.get(paper.id)}
                                mode={mode}
                              />
                            ) : null}
                            {paper.questionsPath ? (
                              <PdfLink
                                paper={paper}
                                kind="questions"
                                labelKey="papers.questions"
                                mode={mode}
                              />
                            ) : null}
                            {paper.solutionsPath ? (
                              <PdfLink
                                paper={paper}
                                kind="solutions"
                                labelKey="papers.solutions"
                                mode={mode}
                              />
                            ) : null}
                            {/* Teacher side only: the review and publish
                                screen (issue 11-ingest-job-review-publish). A
                                student has no draft row to review. */}
                            {showReview ? (
                              <Link
                                href={paperReviewPath(paper.id)}
                                prefetch={false}
                                aria-label={`${paper.label}: ${plain('papers.review', mode)}`}
                                className={DOWNLOAD}
                              >
                                <ListChecks aria-hidden="true" className="size-5" />
                                <span className="flex flex-col items-start">
                                  {labels('papers.review', mode).map((line, index) => (
                                    <span
                                      key={line}
                                      className={index === 0 ? 'block' : 'block text-xs'}
                                    >
                                      {line}
                                    </span>
                                  ))}
                                </span>
                              </Link>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The student's count, Done tick and Practice link (issue
 * 66-papers-question-count). With 0 questions there is no link, only "Questions
 * coming soon": the player would otherwise open on "No questions yet".
 */
function PracticeCell({
  paper,
  teacherId,
  known,
  mode,
}: {
  paper: Paper;
  teacherId: string;
  known: PaperProgress | undefined;
  mode: LangMode;
}) {
  if (known?.questionCount === 0) {
    return <span className={NOTE}>{plain('papers.comingSoon', mode)}</span>;
  }

  return (
    <>
      {known ? (
        <span className={NOTE}>
          <span className="tabular-nums">{known.questionCount}</span>
          <span>{plain('papers.questionsWord', mode)}</span>
        </span>
      ) : null}
      {known?.done ? (
        <span className={NOTE}>
          <Check aria-hidden="true" className="size-4" />
          {plain('papers.done', mode)}
        </span>
      ) : null}
      <Link
        href={playerPath(teacherId, paper.id)}
        prefetch={false}
        aria-label={`${paper.label}: ${plain('player.title', mode)}`}
        className={PRACTICE}
      >
        <Play aria-hidden="true" className="size-5" />
        <span className="flex flex-col items-start">
          {labels('player.title', mode).map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
              {line}
            </span>
          ))}
        </span>
      </Link>
    </>
  );
}

function PdfLink({
  paper,
  kind,
  labelKey,
  mode,
}: {
  paper: Paper;
  kind: PaperKind;
  labelKey: MessageKey;
  mode: LangMode;
}) {
  return (
    <a
      href={paperDownloadPath(paper.id, kind)}
      // The paper name is in the label, so "Questions" on its own is never
      // ambiguous to a screen reader (DESIGN.md section 11).
      aria-label={`${paper.label}: ${plain(labelKey, mode)}`}
      className={DOWNLOAD}
    >
      <FileText aria-hidden="true" className="size-5" />
      <span className="flex flex-col items-start">
        {labels(labelKey, mode).map((line, index) => (
          <span key={line} className={index === 0 ? undefined : 'text-xs'}>
            {line}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className={CHIP}>
        PDF
      </span>
    </a>
  );
}
