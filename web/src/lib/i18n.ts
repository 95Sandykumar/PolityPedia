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
    // Plans (issue 21-plans-entitlements). V18: AI plan Rs 100, Pro Rs 500.
    'plans.title': 'Plans',
    'plans.userId': 'Student user ID',
    'plans.plan': 'Plan',
    'plans.planAi': 'AI plan, Rs 100 a month',
    'plans.planPro': 'Pro, Rs 500 a month',
    'plans.days': 'Days',
    'plans.grant': 'Grant plan',
    'plans.end': 'End plan',
    'plans.granted': 'Plan granted',
    'plans.ended': 'Plan ended',
    'plans.saving': 'Saving...',
    'plans.failed': 'Could not save. Check the user ID and try again.',
    'plans.notConfigured': 'Plans are not set up yet',
    'plans.hint': 'The AI plan unlocks AI explanations. Pro adds notes and score vs cut-off.',
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
    'plans.title': 'प्लान',
    'plans.userId': 'छात्र यूज़र आईडी',
    'plans.plan': 'प्लान',
    'plans.planAi': 'AI प्लान, 100 रुपये महीना',
    'plans.planPro': 'प्रो, 500 रुपये महीना',
    'plans.days': 'दिन',
    'plans.grant': 'प्लान दें',
    'plans.end': 'प्लान बंद करें',
    'plans.granted': 'प्लान दे दिया',
    'plans.ended': 'प्लान बंद कर दिया',
    'plans.saving': 'सेव कर रहे हैं...',
    'plans.failed': 'सेव नहीं हो सका। यूज़र आईडी जाँचें और फिर कोशिश करें।',
    'plans.notConfigured': 'प्लान अभी सेट नहीं हैं',
    'plans.hint': 'AI प्लान से AI व्याख्या खुलती है। प्रो में नोट्स और कट-ऑफ स्कोर भी मिलते हैं।',
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
