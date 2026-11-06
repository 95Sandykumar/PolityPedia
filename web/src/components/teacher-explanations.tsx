'use client';

/**
 * Teacher screen: correct the AI explanation of your own question
 * (issue 24-revision-teacher-edit).
 *
 * Definition of done: "A teacher opens an AI explanation of one of their
 * questions, edits the text, and saves. Students then see the edited version."
 *
 * F7 is the human gate on AI text. The visible half of that gate is the badge
 * on every row: until a teacher has corrected it, the row says so, and the
 * moment they save, it says their name instead. `edited_by_teacher` is the
 * same flag the student screen reads, so the two can never disagree.
 *
 * The rows are read on the server and passed in, so this component holds no
 * key and makes no read of its own. The client is a prop so the test can
 * inject a fake: no real network call and no real key (web/CLAUDE.md).
 *
 * Permission is NOT this screen's job. The gate is the
 * `ai_explanations_update_owner` policy and the `ai_explanations_teacher_edit`
 * trigger inside Postgres, so another teacher's explanation cannot be touched
 * from here even with a crafted id.
 *
 * A failed save leaves the typed text and the row exactly where they were,
 * because nothing changed in the database, so the old state is still the true
 * one.
 */
import { Bot, CircleCheck, Pencil, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CARD, EmptyState, PageHeader } from '@/components/teacher-ui';
import { createBrowserTeacherExplanationsClient } from '@/lib/ai/browser-teacher-explanations-client';
import {
  MAX_REMEMBER,
  MAX_SECTION_BODY,
  MAX_SECTION_HEADING,
  sortTeacherExplanations,
  type BrowserTeacherExplanationsClient,
  type TeacherExplanation,
} from '@/lib/ai/teacher-edit';
import type { ExplanationSection } from '@/lib/ai/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 py-2 text-base text-foreground';

/** One row is a (question, language) pair, which is also the primary key. */
function rowKey(row: { questionId: string; lang: string }): string {
  return row.questionId + ':' + row.lang;
}

/** What the open form holds. A copy, so Cancel really cancels. */
interface Draft {
  sections: ExplanationSection[];
  remember: string;
}

function draftOf(row: TeacherExplanation): Draft {
  return {
    sections: (row.body?.sections ?? []).map((section) => ({ ...section })),
    remember: row.body?.remember ?? '',
  };
}

export function TeacherExplanations({
  explanations,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  explanations: readonly TeacherExplanation[];
  client?: BrowserTeacherExplanationsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserTeacherExplanationsClient(), []);
  const api = client ?? fallback;

  /** The live list: what the server sent, plus this session's corrections. */
  const [rows, setRows] = useState<readonly TeacherExplanation[]>(() =>
    sortTeacherExplanations(explanations),
  );

  /**
   * ONE row open at a time. Two open forms would let a teacher type into both
   * and save them in the wrong order, and the second save would look like it
   * had overwritten the first.
   */
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ sections: [], remember: '' });

  const [busy, setBusy] = useState(false);
  /** One message slot: the newest outcome is the only one worth showing. */
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);

  const title = (
    <PageHeader
      titleKey="teacherEdit.title"
      mode={mode}
      icon={Sparkles}
      back={{ href: '/teacher/home', label: plain('teacherUi.backHome', mode) }}
      subtitle={configured ? plain('teacherEdit.hint', mode) : undefined}
    />
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('teacherEdit.notConfigured', mode)}
        </p>
      </section>
    );
  }

  function open(row: TeacherExplanation) {
    setOpenRow(rowKey(row));
    setDraft(draftOf(row));
    setProblem(null);
    setSaved(false);
  }

  function cancel() {
    setOpenRow(null);
    setProblem(null);
  }

  function setSection(index: number, field: 'heading' | 'body', value: string) {
    setDraft((old) => ({
      ...old,
      sections: old.sections.map((section, i) =>
        i === index ? { ...section, [field]: value } : section,
      ),
    }));
  }

  async function save(row: TeacherExplanation) {
    if (busy) return;
    setSaved(false);

    // Checked here so an obvious mistake costs no round trip. The route and
    // `ai_explanations_edited_body_check` check the same thing again, because
    // a blank human gate is worse than no gate at all.
    const sections = draft.sections
      .map((section) => ({ heading: section.heading.trim(), body: section.body.trim() }))
      .filter((section) => section.body.length > 0);

    if (sections.length !== draft.sections.length || sections.length === 0) {
      setProblem('teacherEdit.needText');
      return;
    }

    setBusy(true);
    setProblem(null);
    try {
      const result = await api.edit({
        questionId: row.questionId,
        lang: row.lang,
        body: {
          // The chips at the top of the student screen are not this form's
          // business, so they are carried through exactly as they were.
          exam: row.body?.exam ?? '',
          topic: row.body?.topic ?? '',
          question: row.body?.question ?? '',
          sections,
          remember: draft.remember.trim(),
        },
      });

      // The saved row comes back from the server, flag and all, so the badge
      // below reads the real stored state and never a guess.
      setRows((old) =>
        sortTeacherExplanations(
          old.map((item) => (rowKey(item) === rowKey(row) ? { ...item, ...result } : item)),
        ),
      );
      setOpenRow(null);
      setSaved(true);
    } catch {
      // Fixed message, and the typed text stays: nothing was saved, so the
      // teacher does not have to write it again.
      setProblem('teacherEdit.failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex max-w-[760px] flex-col gap-4">
      {title}

      {problem ? (
        <p
          role="alert"
          className="rounded-[10px] border border-wrong bg-wrong-soft p-3 text-wrong"
        >
          {plain(problem, mode)}
        </p>
      ) : null}

      {saved ? (
        <p role="status" className="rounded-[10px] bg-primary/10 p-3 font-medium text-primary">
          {plain('teacherEdit.saved', mode)}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState icon={Sparkles} text={plain('teacherEdit.none', mode)} />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const key = rowKey(row);
            const isOpen = openRow === key;
            const several = draft.sections.length > 1;

            return (
              <li key={key} className={cn(CARD, 'flex flex-col gap-3')}>
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium',
                          row.editedByTeacher
                            ? 'bg-primary/10 text-primary'
                            : 'border border-border text-muted-foreground',
                        )}
                      >
                        {row.editedByTeacher ? (
                          <CircleCheck size={12} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <Bot size={12} strokeWidth={2} aria-hidden="true" />
                        )}
                        {plain(row.editedByTeacher ? 'teacherEdit.byYou' : 'teacherEdit.byAi', mode)}
                      </span>
                      <span className="text-xs leading-4 text-muted-foreground uppercase">
                        {row.lang}
                      </span>
                    </span>
                    <span className="text-base font-medium">
                      {row.number === null ? row.stem : `${row.number}. ${row.stem}`}
                    </span>
                  </div>

                  {isOpen ? null : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => open(row)}
                      aria-label={plain('teacherEdit.open', mode)}
                      className="flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-2 rounded-[10px] border border-primary px-3 text-base font-medium text-primary transition-colors duration-100 disabled:opacity-60"
                    >
                      <Pencil size={20} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {isOpen ? (
                  <div className="flex flex-col gap-3">
                    {draft.sections.map((section, index) => (
                      <div key={index} className="flex flex-col gap-1">
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium">
                            {several
                              ? `${plain('teacherEdit.heading', mode)} ${index + 1}`
                              : plain('teacherEdit.heading', mode)}
                          </span>
                          <input
                            type="text"
                            value={section.heading}
                            maxLength={MAX_SECTION_HEADING}
                            onChange={(event) => setSection(index, 'heading', event.target.value)}
                            className={FIELD}
                          />
                        </label>

                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium">
                            {several
                              ? `${plain('teacherEdit.body', mode)} ${index + 1}`
                              : plain('teacherEdit.body', mode)}
                          </span>
                          <textarea
                            rows={5}
                            value={section.body}
                            maxLength={MAX_SECTION_BODY}
                            onChange={(event) => setSection(index, 'body', event.target.value)}
                            className={FIELD}
                          />
                        </label>
                      </div>
                    ))}

                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">
                        {plain('teacherEdit.rememberLine', mode)}
                      </span>
                      <input
                        type="text"
                        value={draft.remember}
                        maxLength={MAX_REMEMBER}
                        onChange={(event) =>
                          setDraft((old) => ({ ...old, remember: event.target.value }))
                        }
                        className={FIELD}
                      />
                    </label>

                    <div className="flex gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void save(row)}
                        aria-label={plain('teacherEdit.save', mode)}
                        className="min-h-12 flex-1 rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60"
                      >
                        {plain(busy ? 'teacherEdit.saving' : 'teacherEdit.save', mode)}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={cancel}
                        aria-label={plain('teacherEdit.cancel', mode)}
                        className="min-h-12 rounded-[10px] border border-border px-3 text-base font-medium transition-colors duration-100 disabled:opacity-60"
                      >
                        {plain('teacherEdit.cancel', mode)}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {(row.body?.sections ?? []).map((section, index) => (
                      <div key={index} className="flex flex-col gap-0.5">
                        {section.heading ? (
                          <span className="text-sm font-medium">{section.heading}</span>
                        ) : null}
                        <span className="text-base whitespace-pre-wrap">{section.body}</span>
                      </div>
                    ))}
                    {row.body?.remember ? (
                      <span className="text-sm text-muted-foreground">{row.body.remember}</span>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
