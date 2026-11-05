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
import { useMemo, useState } from 'react';
import { CHIP, CHIP_OFF, CHIP_ON, LanguageChoice } from '@/components/language-choice';
import { createBrowserExamsClient } from '@/lib/exams/browser-exams-client';
import { examLabels, type BrowserExamsClient, type Exam } from '@/lib/exams/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';

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
      <Title mode={mode} />

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('onboarding.failed', mode)}
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="pb-3 text-lg leading-6 font-bold">
          {plain('onboarding.exams', mode)}
        </legend>
        <ul className="flex flex-wrap gap-2">
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
                  className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                >
                  <span className="flex flex-col items-start">
                    {lines.map((line, index) => (
                      <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                        {line}
                      </span>
                    ))}
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
