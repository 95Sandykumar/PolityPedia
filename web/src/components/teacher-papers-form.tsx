'use client';

/**
 * Teacher Papers: upload a past paper, then see your own list
 * (issue 10-papers-upload-browse, laid out again in teacher-ui).
 *
 * V8 and PRD F-D1: a paper is Exam > Year > Month (optional) > PDF, and it
 * belongs to the teacher who uploaded it. Both PDFs are optional one at a
 * time, but one of them has to be there, or there is nothing to download.
 *
 * LAYOUT. Title and the one primary action on top, then the list, with the
 * upload form in its own card: beside the list on a laptop, under it on a
 * phone. The header button jumps to that card. The list is the teacher's own
 * rows grouped Exam > Year > Month, each row with a status chip (Live or
 * Draft) and its actions: Review first, then the PDFs.
 *
 * Native `<select>` and `<input type="file">` on purpose: a cheap Android
 * phone then shows its own wheel and its own file picker, which beat anything
 * we could ship on 4G (DESIGN.md section 10), and the teacher's laptop gets
 * the file dialog it already knows.
 *
 * A fresh upload is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing goes live here: the row is a DRAFT and the chip says so. Publish is
 * on the review screen (PRD F-D3).
 *
 * The BrowserPapersClient is a prop so the test can inject a fake: no real
 * network call, no real key and no real 31 MB file in any test
 * (web/CLAUDE.md).
 */
import { Download, FileText, ListChecks, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import {
  BOX,
  CARD,
  EmptyState,
  Field,
  FormPanel,
  Lines,
  ListLayout,
  PageHeader,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  StatusChip,
  goToForm,
} from '@/components/teacher-ui';
import { examLabels, type Exam } from '@/lib/exams/types';
import { createBrowserPapersClient } from '@/lib/papers/browser-papers-client';
import {
  MAX_PAPER_LABEL_LENGTH,
  MAX_PAPER_YEAR,
  MIN_PAPER_YEAR,
  groupPapers,
  monthLabels,
  paperDownloadPath,
  type BrowserPapersClient,
  type Paper,
  type PaperKind,
  type PdfPick,
} from '@/lib/papers/types';
import { paperReviewPath } from '@/lib/questions/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The code the client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  'pdf-required': 'papers.needPdf',
  'too-big': 'papers.tooBig',
  'not-pdf': 'papers.notPdf',
  empty: 'papers.notPdf',
  duplicate: 'papers.duplicate',
};

const MONTH_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

const FORM_ID = 'paper-form';

/** A file picker that looks like part of the form, not a browser default. */
const FILE_BOX = `${BOX} py-2 text-sm file:mr-3 file:min-h-8 file:rounded-[8px] file:border-0 file:bg-primary/10 file:px-3 file:text-sm file:font-medium file:text-primary`;

export function TeacherPapersForm({
  exams,
  papers,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** The catalogue. The teacher picks the exam the paper belongs to. */
  exams: readonly Exam[];
  /** The teacher's own papers, drafts included. */
  papers: readonly Paper[];
  client?: BrowserPapersClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserPapersClient(), []);
  const data = client ?? fallback;

  const [rows, setRows] = useState<Paper[]>(() => [...papers]);
  const [examId, setExamId] = useState(exams[0]?.id ?? '');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const questionsRef = useRef<HTMLInputElement>(null);
  const solutionsRef = useRef<HTMLInputElement>(null);

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader titleKey="papers.title" mode={mode} icon={FileText} />
        <p role="status" className="text-muted-foreground">
          {plain('papers.notConfigured', mode)}
        </p>
      </section>
    );
  }

  function firstFile(input: HTMLInputElement | null): PdfPick | null {
    const file = input?.files?.[0];
    return file ? (file as PdfPick) : null;
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(false);
    setProblem(null);

    const questions = firstFile(questionsRef.current);
    const solutions = firstFile(solutionsRef.current);
    // Asked here as well as in the client, so a teacher who forgot the file
    // gets the line straight away and we spend no request on it.
    if (!questions && !solutions) {
      setProblem('papers.needPdf');
      return;
    }

    setBusy(true);
    try {
      const made = await data.create({
        examId,
        year: Number(year),
        // Blank means "year only", which is NULL in the column, not 0.
        month: month === '' ? null : Number(month),
        label,
        questions,
        solutions,
      });

      // Newest row in place, so the teacher sees it land with no reload.
      setRows((current) => [...current, made]);
      setDone(true);
      setLabel('');
      if (questionsRef.current) questionsRef.current.value = '';
      if (solutionsRef.current) solutionsRef.current.value = '';
    } catch (cause) {
      // Our own short code, or the generic line. Never a server message.
      const code = (cause as Error)?.message ?? '';
      setProblem(PROBLEM_LABELS[code] ?? 'papers.failed');
    } finally {
      setBusy(false);
    }
  }

  const newPaper = (
    <button type="button" onClick={() => goToForm(FORM_ID)} className={PRIMARY_BUTTON}>
      <Plus size={20} strokeWidth={2} aria-hidden="true" />
      {plain('teacherUi.newPaper', mode)}
    </button>
  );

  return (
    <section className="flex flex-col gap-6">
      <PageHeader titleKey="papers.title" mode={mode} icon={FileText} action={newPaper} />

      <ListLayout
        list={
          <PaperRows
            papers={rows}
            exams={exams}
            mode={mode}
            empty={
              <EmptyState
                icon={FileText}
                text={plain('papers.none', mode)}
                action={
                  <button
                    type="button"
                    onClick={() => goToForm(FORM_ID)}
                    className={cn(QUIET_BUTTON, 'lg:hidden')}
                  >
                    <Upload size={20} strokeWidth={2} aria-hidden="true" />
                    {plain('teacherUi.newPaper', mode)}
                  </button>
                }
              />
            }
          />
        }
        form={
          <FormPanel id={FORM_ID} titleKey="teacherUi.newPaper" mode={mode} icon={Upload}>
            <form onSubmit={upload} className="flex flex-col gap-3" noValidate>
              <p className="text-sm text-muted-foreground">{plain('papers.hint', mode)}</p>

              {problem ? (
                <p
                  role="alert"
                  className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong"
                >
                  {plain(problem, mode)}
                </p>
              ) : null}

              <Field labelKey="papers.exam" mode={mode}>
                <select
                  value={examId}
                  aria-label={plain('papers.exam', mode)}
                  onChange={(event) => setExamId(event.target.value)}
                  className={BOX}
                >
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>
                      {examLabels(exam, mode).join(' / ')}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field labelKey="papers.year" mode={mode}>
                  <input
                    // `numeric`, so the phone opens a number pad and not a keyboard.
                    type="number"
                    inputMode="numeric"
                    min={MIN_PAPER_YEAR}
                    max={MAX_PAPER_YEAR}
                    value={year}
                    aria-label={plain('papers.year', mode)}
                    onChange={(event) => setYear(event.target.value)}
                    className={`${BOX} tabular-nums`}
                  />
                </Field>

                <Field labelKey="papers.month" mode={mode}>
                  <select
                    value={month}
                    aria-label={plain('papers.month', mode)}
                    onChange={(event) => setMonth(event.target.value)}
                    className={BOX}
                  >
                    {/* First and default: a paper is often known by its year only. */}
                    <option value="">{plain('papers.monthNone', mode)}</option>
                    {MONTH_VALUES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field labelKey="papers.label" mode={mode}>
                <input
                  type="text"
                  value={label}
                  maxLength={MAX_PAPER_LABEL_LENGTH}
                  aria-label={plain('papers.label', mode)}
                  onChange={(event) => setLabel(event.target.value)}
                  className={BOX}
                />
              </Field>

              <Field labelKey="papers.questionsPdf" mode={mode}>
                <input
                  ref={questionsRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  aria-label={plain('papers.questionsPdf', mode)}
                  className={FILE_BOX}
                />
              </Field>

              <Field labelKey="papers.solutionsPdf" mode={mode}>
                <input
                  ref={solutionsRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  aria-label={plain('papers.solutionsPdf', mode)}
                  className={FILE_BOX}
                />
              </Field>

              {done ? (
                <p role="status" className="text-sm font-medium text-primary">
                  {plain('papers.uploaded', mode)}
                </p>
              ) : null}

              <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
                {plain(busy ? 'papers.uploading' : 'papers.upload', mode)}
              </button>
            </form>
          </FormPanel>
        }
      />
    </section>
  );
}

/**
 * The teacher's own papers, Exam > Year > Month, one row each.
 *
 * Same grouping as the student's list (`groupPapers`), but the row is the
 * teacher's: a status chip and Review up front. The aria-labels carry the
 * paper name, so "Questions" on its own is never ambiguous to a screen reader
 * (DESIGN.md section 11).
 */
function PaperRows({
  papers,
  exams,
  mode,
  empty,
}: {
  papers: readonly Paper[];
  exams: readonly Exam[];
  mode: LangMode;
  empty: React.ReactNode;
}) {
  const groups = groupPapers(papers, exams);
  if (groups.length === 0) return <>{empty}</>;

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const examLines =
          mode === 'both' ? [group.nameEn, group.nameHi] : [mode === 'hi' ? group.nameHi : group.nameEn];
        const shown = examLines.filter((line) => line.length > 0);

        return (
          <section key={group.examId} className="flex flex-col gap-3">
            {shown.length > 0 ? (
              <h2 className="text-[18px] leading-6 font-bold">
                {shown.map((line, index) => (
                  <span
                    key={line}
                    className={cn(
                      'block',
                      index === 1 && 'text-sm font-medium text-muted-foreground',
                      mode !== 'en' && 'leading-[26px]',
                    )}
                  >
                    {line}
                  </span>
                ))}
              </h2>
            ) : null}

            {group.years.map((year) =>
              year.months.map((month) => (
                <div key={`${year.year}-${String(month.month)}`} className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <span className="text-base font-bold text-foreground tabular-nums">
                      {year.year}
                    </span>
                    {/* No month name for "year only": there is no month to name. */}
                    {month.month !== null ? (
                      <span className="flex gap-2">
                        {monthLabels(month.month, mode).map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                      </span>
                    ) : null}
                  </h3>

                  <ul className="flex flex-col gap-2">
                    {month.papers.map((paper) => (
                      <li key={paper.id} className={cn(CARD, 'flex flex-col gap-3')}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 font-medium break-words">{paper.label}</span>
                          <StatusChip live={paper.status === 'live'}>
                            {plain(paper.status === 'live' ? 'papers.live' : 'papers.draft', mode)}
                          </StatusChip>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {/* The review and publish screen (issue 11). */}
                          <Link
                            href={paperReviewPath(paper.id)}
                            prefetch={false}
                            aria-label={`${paper.label}: ${plain('papers.review', mode)}`}
                            className={cn(QUIET_BUTTON, 'border-primary text-primary')}
                          >
                            <ListChecks size={20} strokeWidth={2} aria-hidden="true" />
                            <span className="flex flex-col items-start">
                              <Lines keyName="papers.review" mode={mode} />
                            </span>
                          </Link>
                          {paper.questionsPath ? (
                            <PdfLink paper={paper} kind="questions" labelKey="papers.questions" mode={mode} />
                          ) : null}
                          {paper.solutionsPath ? (
                            <PdfLink paper={paper} kind="solutions" labelKey="papers.solutions" mode={mode} />
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )),
            )}
          </section>
        );
      })}
    </div>
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
      aria-label={`${paper.label}: ${plain(labelKey, mode)}`}
      className={QUIET_BUTTON}
    >
      <Download size={20} strokeWidth={2} aria-hidden="true" />
      <span className="flex flex-col items-start">
        <Lines keyName={labelKey} mode={mode} />
      </span>
    </a>
  );
}
