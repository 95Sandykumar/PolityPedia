/**
 * The whole i18n layer for PolityPedia v1. Small on purpose.
 * DESIGN.md section 1: every label a student sees exists in English AND Hindi.
 * Mode `both` shows English with Hindi under it.
 */
export type Lang = 'en' | 'hi';
export type LangMode = Lang | 'both';

export const DEFAULT_MODE: LangMode = 'en';

/** The three language choices, in the order the UI shows them (DESIGN.md D6). */
export const LANG_MODES: readonly LangMode[] = ['en', 'hi', 'both'];

/** True for a value that is safe to store in `profiles.lang`. */
export function isLangMode(value: unknown): value is LangMode {
  return typeof value === 'string' && (LANG_MODES as readonly string[]).includes(value);
}

export const dictionary = {
  en: {
    'nav.home': 'Home',
    'nav.teachers': 'Teachers',
    'nav.practice': 'Practice',
    'nav.saved': 'Saved',
    'nav.me': 'Me',
    'nav.label': 'Main',
    'placeholder.soon': 'Coming soon',
    'nav.teacherHome': 'Teacher',
    'nav.adminHome': 'Admin',
    'auth.title': 'Sign in',
    'auth.google': 'Continue with Google',
    'auth.or': 'or',
    'auth.email': 'Email',
    'auth.sendCode': 'Send code',
    'auth.sending': 'Sending...',
    'auth.codeSent': 'We emailed a 6-digit code',
    'auth.code': '6-digit code',
    'auth.signIn': 'Sign in',
    'auth.checking': 'Checking...',
    'auth.changeEmail': 'Change email',
    'auth.failed': 'Could not sign in. Try again.',
    'auth.notConfigured': 'Sign in is not set up yet',
    'onboarding.title': 'Get started',
    'onboarding.exams': 'Your exams',
    'onboarding.language': 'Language',
    'onboarding.continue': 'Continue',
    'onboarding.saving': 'Saving...',
    'onboarding.failed': 'Could not save. Try again.',
    'onboarding.notConfigured': 'Set up is not ready yet',
    'me.language': 'Language',
    'me.saved': 'Saved',
    'lang.en': 'English',
    'lang.hi': 'Hindi',
    'lang.both': 'Both',
  },
  hi: {
    'nav.home': 'होम',
    'nav.teachers': 'शिक्षक',
    'nav.practice': 'अभ्यास',
    'nav.saved': 'सेव',
    'nav.me': 'मैं',
    'nav.label': 'मुख्य',
    'placeholder.soon': 'जल्द आ रहा है',
    'nav.teacherHome': 'शिक्षक',
    'nav.adminHome': 'एडमिन',
    'auth.title': 'साइन इन',
    'auth.google': 'Google से जारी रखें',
    'auth.or': 'या',
    'auth.email': 'ईमेल',
    'auth.sendCode': 'कोड भेजें',
    'auth.sending': 'भेज रहे हैं...',
    'auth.codeSent': 'हमने 6 अंकों का कोड ईमेल किया',
    'auth.code': '6 अंकों का कोड',
    'auth.signIn': 'साइन इन',
    'auth.checking': 'जाँच रहे हैं...',
    'auth.changeEmail': 'ईमेल बदलें',
    'auth.failed': 'साइन इन नहीं हो सका। फिर कोशिश करें।',
    'auth.notConfigured': 'साइन इन अभी सेट नहीं है',
    'onboarding.title': 'शुरू करें',
    'onboarding.exams': 'आपकी परीक्षाएँ',
    'onboarding.language': 'भाषा',
    'onboarding.continue': 'जारी रखें',
    'onboarding.saving': 'सेव हो रहा है...',
    'onboarding.failed': 'सेव नहीं हुआ। फिर कोशिश करें।',
    'onboarding.notConfigured': 'सेटअप अभी तैयार नहीं है',
    'me.language': 'भाषा',
    'me.saved': 'सेव हो गया',
    'lang.en': 'अंग्रेज़ी',
    'lang.hi': 'हिंदी',
    'lang.both': 'दोनों',
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
