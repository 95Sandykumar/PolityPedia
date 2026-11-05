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
import { useMemo, useState } from 'react';
import { createBrowserAuthClient } from '@/lib/auth/browser-auth-client';
import type { BrowserAuthClient } from '@/lib/auth/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const GOOGLE_PATH = '/auth/google';
const CODE_LENGTH = 6;

/** DESIGN.md: 48 px touch target, radius 10, 1 px border, tokens only. */
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PRIMARY_BUTTON =
  'min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';
const OUTLINE_BUTTON =
  'flex min-h-12 w-full items-center justify-center rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100';

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
}: {
  client?: BrowserAuthClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** Called after a successful verify. Defaults to a reload of Home. */
  onSignedIn?: () => void;
}) {
  const fallback = useMemo(() => createBrowserAuthClient(), []);
  const auth = client ?? fallback;

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        <h1 className="text-[22px] leading-7 font-bold">
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
    setFailed(false);
    try {
      await auth.sendEmailCode(email.trim());
      setStep('code');
    } catch {
      // Fixed message only: the thrown error may quote Supabase.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (code.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await auth.verifyEmailCode(email.trim(), code);
      if (onSignedIn) onSignedIn();
      else window.location.assign('/');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        <Lines keyName="auth.title" mode={mode} />
      </h1>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('auth.failed', mode)}
        </p>
      ) : null}

      {step === 'email' ? (
        <>
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
              {plain(busy ? 'auth.sending' : 'auth.sendCode', mode)}
            </button>
          </form>
        </>
      ) : (
        <form onSubmit={verifyCode} className="flex flex-col gap-3" noValidate>
          <p className="text-sm text-muted-foreground">{plain('auth.codeSent', mode)}</p>
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
            onClick={() => {
              setStep('email');
              setCode('');
              setFailed(false);
            }}
            className="min-h-12 text-sm font-medium text-primary"
          >
            {plain('auth.changeEmail', mode)}
          </button>
        </form>
      )}
    </section>
  );
}
