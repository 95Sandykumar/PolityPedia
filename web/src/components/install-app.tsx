'use client';

/**
 * Me > Install app (issue 78-installable-app).
 *
 * Shows the button ONLY after the browser fires `beforeinstallprompt`, which is
 * the browser saying "this app can be installed now". No event, no button: the
 * button never promises something the browser will not do.
 *
 * iOS Safari never fires that event, so there the student gets one line that
 * says how to install by hand. It is hidden once the app already runs from the
 * home screen (standalone).
 *
 * DESIGN.md: 48 px touch target, 1 px border, no shadow, radius 10 px, tokens
 * only, one line of help text.
 */
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMounted } from '@/components/use-mounted';
import { labels, plain, type LangMode } from '@/lib/i18n';

/** The (non standard) event Chrome and Edge fire when the app can be installed. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

function isIos(userAgent: string): boolean {
  return /iPhone|iPad|iPod/.test(userAgent);
}

function runsStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const matched = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  return matched || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function InstallApp({
  mode,
  userAgent,
  standalone,
}: {
  mode: LangMode;
  /** Defaults to the browser's. A prop so a test can pick a phone. */
  userAgent?: string;
  /** Defaults to the browser's display mode. */
  standalone?: boolean;
}) {
  const mounted = useMounted();
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    function onPrompt(event: Event) {
      event.preventDefault(); // hold it: the browser's own bar would show at a random moment
      setOffer(event as InstallPromptEvent);
    }
    function onInstalled() {
      setOffer(null);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    if (!offer) return;
    const held = offer;
    // One prompt per event: it cannot be shown twice, so the button goes either way.
    setOffer(null);
    try {
      await held.prompt();
      await held.userChoice;
    } catch {
      // The browser refused to show it. Nothing to tell the student.
    }
  }

  const showIosHint =
    mounted &&
    isIos(userAgent ?? navigator.userAgent) &&
    !(standalone ?? runsStandalone());

  if (offer) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-12 w-full items-center justify-between gap-2 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100"
      >
        <span>
          {labels('me.installApp', mode).map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
              {line}
            </span>
          ))}
        </span>
        <Download aria-hidden="true" className="size-5 text-muted-foreground" />
      </button>
    );
  }

  if (showIosHint) {
    return <p className="text-sm leading-5 text-muted-foreground">{plain('me.installIos', mode)}</p>;
  }

  return null;
}
