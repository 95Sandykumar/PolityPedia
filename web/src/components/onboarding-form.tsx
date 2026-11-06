'use client';

/**
 * First sign-in screen (issue 04-exams-onboarding).
 *
 * Two choices, one action: exam chips (multi-select) and a 3-way language
 * pick, then Continue. DESIGN.md D6: this and Me > Language are the only two
 * places a language is chosen, never the top bar.
 *
 * The BrowserExamsClient is a prop so the test can inject a fake: no real
 * network call and no real key in any test (web/CLAUDE.md).
 */
import { BookOpenCheck, Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconChip } from '@/components/student-ui';
import { LanguageChoice } from '@/components/language-choice';
import { createBrowserExamsClient } from '@/lib/exams/browser-exams-client';
import { examLabels, type BrowserExamsClient, type Exam } from '@/lib/exams/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';

/** One exam row: a full-width 56 px tile with a check box on the right. */
const EXAM_ROW =
  'flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left text-base leading-6 transition-colors duration-100';
const EXAM_ON = 'border-primary bg-primary/5 font-medium text-foreground ring-1 ring-primary';
const EXAM_OFF = 'border-border bg-card text-foreground';

export function OnboardingForm({
  exams,
  client,
  mode = DEFAULT_MODE,
  configured = true,
  onDone,
}: {
  exams: readonly Exam[];
  client?: BrowserExamsClient;
  /** Display language for the labels on this screen. */
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** Called after a successful save. Defaults to going Home. */
  onDone?: () => void;
}) {
  const fallback = useMemo(() => createBrowserExamsClient(), []);
  const data = client ?? fallback;

  const [picked, setPicked] = useState<readonly string[]>([]);
  const [lang, setLang] = useState<LangMode>(DEFAULT_MODE);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <Title mode={mode} />
        <p role="status" className="text-muted-foreground">
          {plain('onboarding.notConfigured', mode)}
        </p>
      </section>
    );
  }

  function toggle(examId: string) {
    setPicked((current) =>
      current.includes(examId) ? current.filter((id) => id !== examId) : [...current, examId],
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await data.saveOnboarding({ examIds: picked, lang });
      if (onDone) onDone();
      else window.location.assign('/');
    } catch {
      // Fixed message only: the thrown error may quote Supabase.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6" noValidate>
      <div className="flex flex-col gap-3">
        <IconChip Icon={BookOpenCheck} size="lg" />
        <Title mode={mode} />
        <p className="text-base leading-6 text-muted-foreground">{plain('sui.onbHint', mode)}</p>
      </div>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('onboarding.failed', mode)}
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="flex w-full items-center gap-2 pb-3 text-lg leading-6 font-bold">
          {plain('onboarding.exams', mode)}
          {picked.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-2 text-sm leading-6 font-medium text-primary tabular-nums">
              {picked.length} {plain('sui.onbPicked', mode)}
            </span>
          ) : null}
        </legend>
        <ul className="flex flex-col gap-2">
          {exams.map((exam) => {
            const on = picked.includes(exam.id);
            const lines = examLabels(exam, mode);
            return (
              <li key={exam.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={lines.join(' / ')}
                  onClick={() => toggle(exam.id)}
                  className={cn(EXAM_ROW, on ? EXAM_ON : EXAM_OFF)}
                >
                  <span className="flex grow flex-col items-start">
                    {lines.map((line, index) => (
                      <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                        {line}
                      </span>
                    ))}
                  </span>
                  {/* A real check, not colour alone (DESIGN.md section 3). */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-[6px] border',
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card',
                    )}
                  >
                    {on ? <Check className="size-4" strokeWidth={3} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <LanguageChoice name="onboarding-lang" mode={mode} value={lang} onPick={setLang} />

      <button type="submit" disabled={picked.length === 0 || busy} className={PRIMARY_BUTTON}>
        {plain(busy ? 'onboarding.saving' : 'onboarding.continue', mode)}
      </button>
    </form>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('onboarding.title', mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </h1>
  );
}
