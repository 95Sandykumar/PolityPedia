'use client';

/**
 * Registers `/sw.js` (issue 78-installable-app). Renders nothing.
 *
 * Scope is `/`. Production only: in `next dev` a worker would only get in the
 * way of hot reload. A failed registration is ignored, because the worker is a
 * nice to have (the offline page) and the app works the same without it.
 */
import { useEffect } from 'react';

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
    if (!enabled) return;
    const target =
      serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
    if (!target) return;
    target.register('/sw.js', { scope: '/' }).catch(() => {});
  }, [serviceWorker, enabled]);

  return null;
}
