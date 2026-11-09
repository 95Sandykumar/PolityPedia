/** Issue 78-installable-app: registers /sw.js with scope "/". */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceWorkerRegister } from '../service-worker-register';

describe('ServiceWorkerRegister', () => {
  it('registers /sw.js with scope /', () => {
    const register = vi.fn(async () => ({}));
    render(<ServiceWorkerRegister serviceWorker={{ register }} enabled />);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing when disabled (dev) or when the browser has no service worker', () => {
    const register = vi.fn(async () => ({}));
    render(<ServiceWorkerRegister serviceWorker={{ register }} enabled={false} />);
    render(<ServiceWorkerRegister serviceWorker={undefined} enabled />);
    expect(register).not.toHaveBeenCalled();
  });

  it('swallows a failed registration', async () => {
    const register = vi.fn(async () => {
      throw new Error('nope');
    });
    expect(() => render(<ServiceWorkerRegister serviceWorker={{ register }} enabled />)).not.toThrow();
    await Promise.resolve();
  });
});
