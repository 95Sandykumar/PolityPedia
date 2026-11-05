import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
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
