'use client';

/**
 * The 3-way language pick (issue 04-exams-onboarding).
 *
 * Shared by the first sign-in screen and Me > Language, which DESIGN.md D6
 * says are the only two places a language is chosen. Its own file so the Me
 * tab does not pull the whole onboarding screen into its bundle (DESIGN.md
 * section 10: 150 KB first-load budget on 4G).
 *
 * Real radio inputs, so it is keyboard reachable (DESIGN.md section 11).
 */
import { LANG_MODES, labels, plain, type LangMode } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** DESIGN.md: 48 px touch target, pill radius 999, 1 px border, tokens only. */
export const CHIP =
  'flex min-h-12 items-center rounded-full border px-4 text-base transition-colors duration-100';
export const CHIP_ON = 'border-primary bg-primary/10 text-primary font-medium';
export const CHIP_OFF = 'border-border bg-card text-foreground';

/**
 * The 3-way language pick, shared by this screen and Me > Language.
 * Real radio inputs, so it is keyboard reachable (DESIGN.md section 11).
 */
export function LanguageChoice({
  name,
  mode,
  value,
  onPick,
  disabled = false,
  legendKey = 'onboarding.language',
}: {
  name: string;
  mode: LangMode;
  value: LangMode;
  onPick: (next: LangMode) => void;
  disabled?: boolean;
  legendKey?: 'onboarding.language' | 'me.language';
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="pb-3 text-lg leading-6 font-bold">{plain(legendKey, mode)}</legend>
      <div className="flex flex-wrap gap-2">
        {LANG_MODES.map((option) => {
          const on = option === value;
          const lines = labels(`lang.${option}`, mode);
          return (
            <label
              key={option}
              className={cn(
                CHIP,
                // The input itself is visually hidden, so the ring lives on the
                // label (DESIGN.md section 11: a visible 2 px focus ring).
                'cursor-pointer focus-within:ring-2 focus-within:ring-ring',
                on ? CHIP_ON : CHIP_OFF,
              )}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={on}
                disabled={disabled}
                aria-label={lines.join(' / ')}
                onChange={() => onPick(option)}
                className="sr-only"
              />
              <span className="flex flex-col items-start">
                {lines.map((line, index) => (
                  <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                    {line}
                  </span>
                ))}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
