'use client';

/**
 * Me > Install app (issue 78-installable-app).
 *
 * Shows the button ONLY when the browser has said "this app can be installed
 * now" by firing `beforeinstallprompt`. No offer, no button: the button never
 * promises something the browser will not do.
 *
 * That event fires once, soon after the page loads, which is usually before the
 * student taps Me. So the offer is caught and held by `install-prompt.ts`,
 * started by the register in the root layout, and read here on mount
 * (issue 82-fix-install-button-missed-event).
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
import {
  captureInstallPrompt,
  clearInstallPrompt,
  heldInstallPrompt,
  watchInstallPrompt,
  type InstallPromptEvent,
} from '@/lib/install-prompt';

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
    // The layout started this already. The call is here too so the button still
    // works on a page that renders it without the layout (a test, a story).
    captureInstallPrompt();
    setOffer(heldInstallPrompt()); // an offer made before this mount
    return watchInstallPrompt(setOffer); // and any offer made after it
  }, []);

  async function install() {
    const held = heldInstallPrompt();
    if (!held) return;
    // One prompt per event: it cannot be shown twice, so the button goes either way.
    clearInstallPrompt();
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
