'use client';

/**
 * Teacher Papers: upload a past paper, then see your own list
 * (issue 10-papers-upload-browse).
 *
 * V8 and PRD F-D1: a paper is Exam > Year > Month (optional) > PDF, and it
 * belongs to the teacher who uploaded it. Both PDFs are optional one at a
 * time, but one of them has to be there, or there is nothing to download.
 *
 * Native `<select>` and `<input type="file">` on purpose: a cheap Android
 * phone then shows its own wheel and its own file picker, which beat anything
 * we could ship on 4G (DESIGN.md section 10), and the teacher's laptop gets
 * the file dialog it already knows.
 *
 * A fresh upload is added to the list in place, so the teacher sees it land
 * without a page reload on a connection that drops.
 *
 * Nothing goes live here: the row is a DRAFT and the badge says so. Publish is
 * issue 11 (PRD F-D3).
 *
 * The BrowserPapersClient is a prop so the test can inject a fake: no real
 * network call, no real key and no real 31 MB file in any test
 * (web/CLAUDE.md).
 */
import { useMemo, useRef, useState } from 'react';
import { PapersList } from '@/components/papers-list';
import { examLabels, type Exam } from '@/lib/exams/types';
import { createBrowserPapersClient } from '@/lib/papers/browser-papers-client';
import {
  MAX_PAPER_LABEL_LENGTH,
  MAX_PAPER_YEAR,
  MIN_PAPER_YEAR,
  type BrowserPapersClient,
  type Paper,
  type PdfPick,
} from '@/lib/papers/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground';

/** The code the client throws -> the one line the teacher reads. */
const PROBLEM_LABELS: Record<string, MessageKey> = {
  'pdf-required': 'papers.needPdf',
  'too-big': 'papers.tooBig',
  'not-pdf': 'papers.notPdf',
  empty: 'papers.notPdf',
  duplicate: 'papers.duplicate',
};

const MONTH_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

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
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
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

  return (
    <section className="flex flex-col gap-6">
      <form onSubmit={upload} className="flex flex-col gap-3" noValidate>
        <Title mode={mode} />
        <p className="text-muted-foreground">{plain('papers.hint', mode)}</p>

        {problem ? (
          <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
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

        <div className="flex flex-col gap-3 md:flex-row">
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
            className={`${BOX} py-3`}
          />
        </Field>

        <Field labelKey="papers.solutionsPdf" mode={mode}>
          <input
            ref={solutionsRef}
            type="file"
            accept="application/pdf,.pdf"
            aria-label={plain('papers.solutionsPdf', mode)}
            className={`${BOX} py-3`}
          />
        </Field>

        {done ? (
          <p role="status" className="text-muted-foreground">
            {plain('papers.uploaded', mode)}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {plain(busy ? 'papers.uploading' : 'papers.upload', mode)}
        </button>
      </form>

      {/* `showReview` opens the check-and-publish screen for each paper
          (issue 11-ingest-job-review-publish). Teacher side only. */}
      <PapersList papers={rows} exams={exams} mode={mode} showStatus showReview />
    </section>
  );
}

/** A visible label above the box, plus the same text as the aria-label. */
function Field({
  labelKey,
  mode,
  children,
}: {
  labelKey: MessageKey;
  mode: LangMode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex w-full flex-col gap-1">
      <span className="text-sm font-medium text-muted-foreground">
        {labels(labelKey, mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </span>
      {children}
    </label>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('papers.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
