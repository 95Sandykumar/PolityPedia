import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    // 150+ test files, 27 of them boot a PGlite WASM engine. On a 32-core machine
    // vitest starts ~31 workers and some die ("Worker exited unexpectedly"), which
    // Ralph reads as TRUNK RED. A cap keeps the suite steady.
    maxWorkers: 8,
    projects: [
      // UI and library tests. jsdom + testing-library.
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          globals: false,
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      // Database tests. Real Postgres through PGlite, so node (no DOM) and a
      // longer timeout, because the first boot of the WASM engine is slow.
      {
        resolve: { alias },
        test: {
          name: 'db',
          environment: 'node',
          globals: false,
          include: ['test/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
