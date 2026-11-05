'use client';

/**
 * Me > Language (issue 04-exams-onboarding).
 *
 * DESIGN.md D6: this is the ONLY language toggle in the app apart from the
 * first sign-in screen. There is no toggle in the top bar, by design.
 *
 * Picking a language saves straight away (one action per screen, DESIGN.md
 * section 2) to `profiles.lang`, so the choice follows the student to every
 * device. A failed save puts the old choice back, so the screen never claims
 * something it did not store.
 */
import { useMemo, useState } from 'react';
import { LanguageChoice } from '@/components/language-choice';
import { createBrowserExamsClient } from '@/lib/exams/browser-exams-client';
import type { BrowserExamsClient } from '@/lib/exams/types';
import { plain, type LangMode } from '@/lib/i18n';

export function LanguageSetting({
  value,
  client,
  configured = true,
}: {
  /** The saved `profiles.lang`. Also the language this screen is shown in. */
  value: LangMode;
  client?: BrowserExamsClient;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserExamsClient(), []);
  const data = client ?? fallback;

  const [lang, setLang] = useState<LangMode>(value);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!configured) {
    return (
      <p role="status" className="text-muted-foreground">
        {plain('onboarding.notConfigured', value)}
      </p>
    );
  }

  async function pick(next: LangMode) {
    if (next === lang || busy) return;
    const previous = lang;
    setLang(next);
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await data.saveLang(next);
      setSaved(true);
    } catch {
      // Fixed message only, and the old choice comes back.
      setLang(previous);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('onboarding.failed', lang)}
        </p>
      ) : null}

      <LanguageChoice
        name="me-lang"
        legendKey="me.language"
        mode={lang}
        value={lang}
        onPick={pick}
        disabled={busy}
      />

      {/* aria-live region: the save is announced, not just coloured. */}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {saved ? plain('me.saved', lang) : ''}
      </p>
    </section>
  );
}
