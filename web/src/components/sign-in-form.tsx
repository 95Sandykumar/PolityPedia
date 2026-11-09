'use client';

/**
 * Sign-in screen (issue 03-sign-in).
 *
 * Two steps: email, then the 6-digit code. Google goes through the server
 * route `/auth/google`, which owns the PKCE pair.
 *
 * The AuthClient is a prop so the test can inject a fake: no real network call
 * and no real key in any test (web/CLAUDE.md).
 *
 * Security: the typed code never appears in an error message, and nothing here
 * is logged.
 */
import { BookOpenCheck, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { IconChip } from '@/components/student-ui';
import { createBrowserAuthClient } from '@/lib/auth/browser-auth-client';
import { queryErrorKey, reasonKey, reasonOf } from '@/lib/auth/sign-in-errors';
import type { BrowserAuthClient } from '@/lib/auth/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const GOOGLE_PATH = '/auth/google';
const CODE_LENGTH = 6;
/** Seconds the Resend button stays locked after a send (issue 64-signin-errors-and-resend). */
export const RESEND_COOLDOWN_SECONDS = 30;

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PRIMARY_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60';
const OUTLINE_BUTTON =
  'flex min-h-12 w-full items-center justify-center rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100';

/** The brand block on top of both states: a mark, the name and what the app is for. */
function Brand({ mode }: { mode: LangMode }) {
  return (
    <div className="flex flex-col items-start gap-4 pb-2">
      <div className="flex items-center gap-3">
        <IconChip Icon={BookOpenCheck} size="lg" />
        <p className="text-[22px] leading-8 font-bold">{plain('sui.brand', mode)}</p>
      </div>
      <p className="text-base leading-6 text-muted-foreground">{plain('sui.authTagline', mode)}</p>
    </div>
  );
}

function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </>
  );
}

export function SignInForm({
  client,
  mode = DEFAULT_MODE,
  configured = true,
  onSignedIn,
  initialError,
}: {
  client?: BrowserAuthClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** Called after a successful verify. Defaults to a reload of Home. */
  onSignedIn?: () => void;
  /**
   * The raw `?error=` value the Google callback sent. Only the five known
   * values show a message; anything else is ignored (issue 64-signin-errors-and-resend).
   */
  initialError?: string;
}) {
  const fallback = useMemo(() => createBrowserAuthClient(), []);
  const auth = client ?? fallback;

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // The key of the message in the banner, or null for no banner.
  const [failure, setFailure] = useState<MessageKey | null>(() => queryErrorKey(initialError));
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);

  // One interval runs while the cooldown is above zero. It depends on the
  // boolean, not the number, so the tick is not torn down every second.
  const counting = cooldown > 0;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setCooldown((left) => Math.max(0, left - 1)), 1000);
    return () => clearInterval(id);
  }, [counting]);

  if (!configured) {
    return (
      <section className="flex flex-col gap-4">
        <Brand mode={mode} />
        <h1 className="text-[22px] leading-8 font-bold">
          <Lines keyName="auth.title" mode={mode} />
        </h1>
        <p role="status" className="text-muted-foreground">
          {plain('auth.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    setResent(false);
    try {
      await auth.sendEmailCode(email.trim());
      setStep('code');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      // A fixed message per reason only: the thrown error may quote Supabase.
      setFailure(reasonKey(reasonOf(error)));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    setFailure(null);
    setResent(false);
    try {
      await auth.sendEmailCode(email.trim());
      setResent(true);
    } catch (error) {
      setFailure(reasonKey(reasonOf(error)));
    } finally {
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (code.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    setFailure(null);
    setResent(false);
    try {
      await auth.verifyEmailCode(email.trim(), code);
      if (onSignedIn) onSignedIn();
      else window.location.assign('/');
    } catch (error) {
      setFailure(reasonKey(reasonOf(error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <Brand mode={mode} />
      <h1 className="text-[22px] leading-8 font-bold">
        <Lines keyName="auth.title" mode={mode} />
      </h1>

      {failure ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain(failure, mode)}
        </p>
      ) : null}

      {step === 'email' ? (
        <div className="flex flex-col gap-4 rounded-[10px] border border-border bg-card p-4">
          <a href={GOOGLE_PATH} aria-label={plain('auth.google', mode)} className={OUTLINE_BUTTON}>
            <span>
              <Lines keyName="auth.google" mode={mode} />
            </span>
          </a>

          <p className="text-center text-sm text-muted-foreground">{plain('auth.or', mode)}</p>

          <form onSubmit={sendCode} className="flex flex-col gap-3" noValidate>
            <label htmlFor="sign-in-email" className="text-sm font-medium">
              <Lines keyName="auth.email" mode={mode} />
            </label>
            <input
              id="sign-in-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD}
            />
            <button
              type="submit"
              disabled={busy}
              aria-label={plain('auth.sendCode', mode)}
              className={PRIMARY_BUTTON}
            >
              <Mail aria-hidden="true" className="size-5" strokeWidth={2} />
              {plain(busy ? 'auth.sending' : 'auth.sendCode', mode)}
            </button>
            <p className="text-sm leading-5 text-muted-foreground">
              {plain('sui.authNoPassword', mode)}
            </p>
          </form>
        </div>
      ) : (
        <form
          onSubmit={verifyCode}
          className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4"
          noValidate
        >
          <p className="text-sm text-muted-foreground">{plain('auth.codeSent', mode)}</p>
          <p className="text-sm text-muted-foreground">{plain('auth.codeExpires', mode)}</p>
          <p className="text-sm text-muted-foreground">{plain('auth.spamHint', mode)}</p>
          {resent ? (
            <p role="status" className="text-sm text-foreground">
              {plain('auth.resent', mode)}
            </p>
          ) : null}
          <label htmlFor="sign-in-code" className="text-sm font-medium">
            <Lines keyName="auth.code" mode={mode} />
          </label>
          <input
            id="sign-in-code"
            name="code"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={CODE_LENGTH}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className={FIELD + ' tracking-[0.3em] tabular-nums'}
          />
          <button
            type="submit"
            disabled={busy}
            aria-label={plain('auth.signIn', mode)}
            className={PRIMARY_BUTTON}
          >
            {plain(busy ? 'auth.checking' : 'auth.signIn', mode)}
          </button>
          <button
            type="button"
            onClick={resendCode}
            disabled={busy || cooldown > 0}
            className={OUTLINE_BUTTON + ' disabled:opacity-60'}
          >
            {cooldown > 0
              ? plain('auth.resend', mode) + ' (' + cooldown + 's)'
              : plain('auth.resend', mode)}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
              setFailure(null);
              setResent(false);
              setCooldown(0);
            }}
            className="min-h-12 text-sm font-medium text-primary"
          >
            {plain('auth.changeEmail', mode)}
          </button>
        </form>
      )}
      <p className="flex items-center gap-2 text-sm leading-5 text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
        {plain('sui.authSafe', mode)}
      </p>
    </section>
  );
}
