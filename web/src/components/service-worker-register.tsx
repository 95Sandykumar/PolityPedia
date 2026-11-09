'use client';

/**
 * Registers `/sw.js` (issue 78-installable-app). Renders nothing.
 *
 * Scope is `/`. Production only: in `next dev` a worker would only get in the
 * way of hot reload. A failed registration is ignored, because the worker is a
 * nice to have (the offline page) and the app works the same without it.
 *
 * It also starts the install offer listener, because the root layout mounts
 * this component on every page and the browser fires `beforeinstallprompt`
 * once, soon after load. The Install button on Me mounts later and reads the
 * held offer (issue 82-fix-install-button-missed-event). That part runs in dev
 * too: it registers nothing and costs one listener.
 */
import { useEffect } from 'react';
import { captureInstallPrompt } from '@/lib/install-prompt';

type Registrar = { register: (url: string, options?: { scope: string }) => Promise<unknown> };

export function ServiceWorkerRegister({
  serviceWorker,
  enabled = process.env.NODE_ENV === 'production',
}: {
  /** The browser's `navigator.serviceWorker`. A prop so a test can fake it. */
  serviceWorker?: Registrar;
  enabled?: boolean;
}) {
  useEffect(() => {
    captureInstallPrompt();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const target =
      serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
    if (!target) return;
    target.register('/sw.js', { scope: '/' }).catch(() => {});
  }, [serviceWorker, enabled]);

  return null;
}
