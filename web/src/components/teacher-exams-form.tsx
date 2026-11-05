'use client';

/**
 * Teacher Profile: pick your exams, set the next date for each
 * (issue 07-next-exam-date-teacher-shell).
 *
 * V7: the date is PER TEACHER and PER EXAM, so this screen is a list of the
 * teacher's own exams, not a platform calendar.
 *
 * Shape follows the onboarding screen a student already knows: chips to pick,
 * one action at the bottom. A picked exam opens two small boxes under it, the
 * date and a short name for the pill ("NET" in "Next exam: NET 18 Dec").
 *
 * A native `<input type="date">` on purpose: a cheap Android phone then shows
 * its own date wheel, which is faster than any picker we could ship on 4G, and
 * it hands back `YYYY-MM-DD`, exactly the shape the database column wants.
 *
 * The BrowserTeacherExamsClient is a prop so the test can inject a fake: no
 * real network call and no real key in any test (web/CLAUDE.md).
 */
import { useMemo, useState } from 'react';
import { CHIP, CHIP_OFF, CHIP_ON } from '@/components/language-choice';
import { examLabels, type Exam } from '@/lib/exams/types';
import { createBrowserTeacherExamsClient } from '@/lib/teacher-exams/browser-teacher-exams-client';
import {
  MAX_EXAM_LABEL_LENGTH,
  type BrowserTeacherExamsClient,
  type TeacherExam,
} from '@/lib/teacher-exams/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground';

/** What the form holds while the teacher types. Empty string, never null. */
interface Draft {
  date: string;
  label: string;
}

type Drafts = Record<string, Draft>;

function toDrafts(items: readonly TeacherExam[]): Drafts {
  const out: Drafts = {};
  for (const item of items) {
    out[item.examId] = { date: item.nextExamDate ?? '', label: item.label ?? '' };
  }
  return out;
}

export function TeacherExamsForm({
  exams,
  items,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  /** The whole catalogue. The teacher picks their own out of it. */
  exams: readonly Exam[];
  /** Rows already saved, so an edit is not a retype. */
  items: readonly TeacherExam[];
  client?: BrowserTeacherExamsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserTeacherExamsClient(), []);
  const data = client ?? fallback;

  const [drafts, setDrafts] = useState<Drafts>(() => toDrafts(items));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('teacherProfile.notConfigured', mode)}
        </p>
      </section>
    );
  }

  function toggle(examId: string) {
    setSaved(false);
    setDrafts((current) => {
      if (examId in current) {
        const next = { ...current };
        delete next[examId];
        return next;
      }
      return { ...current, [examId]: { date: '', label: '' } };
    });
  }

  function edit(examId: string, field: keyof Draft, value: string) {
    setSaved(false);
    setDrafts((current) =>
      examId in current ? { ...current, [examId]: { ...current[examId], [field]: value } } : current,
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setSaved(false);

    // Walk the catalogue, not the draft object, so the order the teacher sees
    // is the order that goes over the wire.
    const picked: TeacherExam[] = [];
    for (const exam of exams) {
      const draft = drafts[exam.id];
      if (!draft) continue;
      const label = draft.label.trim();
      picked.push({
        examId: exam.id,
        // Empty means "not announced yet", which is NULL in the column, not ''.
        nextExamDate: draft.date === '' ? null : draft.date,
        label: label === '' ? null : label,
      });
    }

    try {
      await data.save(picked);
      setSaved(true);
    } catch {
      // Fixed message only: the thrown error may quote Postgres.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6" noValidate>
      <Title mode={mode} />
      <p className="text-muted-foreground">{plain('teacherProfile.hint', mode)}</p>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('teacherProfile.failed', mode)}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {exams.map((exam) => {
          const draft = drafts[exam.id];
          const lines = examLabels(exam, mode);
          const name = lines.join(' / ');
          return (
            <li key={exam.id} className="flex flex-col gap-2">
              <button
                type="button"
                aria-pressed={draft !== undefined}
                aria-label={name}
                onClick={() => toggle(exam.id)}
                className={cn(CHIP, draft ? CHIP_ON : CHIP_OFF)}
              >
                <span className="flex flex-col items-start">
                  {lines.map((line, index) => (
                    <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                      {line}
                    </span>
                  ))}
                </span>
              </button>

              {draft ? (
                <div className="flex flex-col gap-2 pl-3 md:flex-row">
                  <input
                    type="date"
                    value={draft.date}
                    aria-label={`${plain('teacherProfile.date', mode)}: ${name}`}
                    onChange={(event) => edit(exam.id, 'date', event.target.value)}
                    className={BOX}
                  />
                  <input
                    type="text"
                    value={draft.label}
                    maxLength={MAX_EXAM_LABEL_LENGTH}
                    aria-label={`${plain('teacherProfile.label', mode)}: ${name}`}
                    placeholder={plain('teacherProfile.label', mode)}
                    onChange={(event) => edit(exam.id, 'label', event.target.value)}
                    className={BOX}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {saved ? (
        <p role="status" className="text-muted-foreground">
          {plain('teacherProfile.saved', mode)}
        </p>
      ) : null}

      <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
        {plain(busy ? 'teacherProfile.saving' : 'teacherProfile.save', mode)}
      </button>
    </form>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('teacherProfile.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
