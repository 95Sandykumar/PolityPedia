/**
 * The whole i18n layer for PolityPedia v1. Small on purpose.
 * DESIGN.md section 1: every label a student sees exists in English AND Hindi.
 * Mode `both` shows English with Hindi under it.
 */
export type Lang = 'en' | 'hi';
export type LangMode = Lang | 'both';

export const DEFAULT_MODE: LangMode = 'en';

export const dictionary = {
  en: {
    'nav.home': 'Home',
    'nav.teachers': 'Teachers',
    'nav.practice': 'Practice',
    'nav.saved': 'Saved',
    'nav.me': 'Me',
    'nav.label': 'Main',
    'placeholder.soon': 'Coming soon',
  },
  hi: {
    'nav.home': 'होम',
    'nav.teachers': 'शिक्षक',
    'nav.practice': 'अभ्यास',
    'nav.saved': 'सेव',
    'nav.me': 'मैं',
    'nav.label': 'मुख्य',
    'placeholder.soon': 'जल्द आ रहा है',
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type MessageKey = keyof (typeof dictionary)['en'];

export function t(key: MessageKey, lang: Lang): string {
  return dictionary[lang][key];
}

/** Returns the strings to show for a key: one for en/hi, two (en then hi) for both. */
export function labels(key: MessageKey, mode: LangMode): string[] {
  if (mode === 'both') return [t(key, 'en'), t(key, 'hi')];
  return [t(key, mode)];
}

/** Single plain string for aria-labels: both = "English / Hindi". */
export function plain(key: MessageKey, mode: LangMode): string {
  return labels(key, mode).join(' / ');
}
