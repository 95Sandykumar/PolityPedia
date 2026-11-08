/**
 * Load `web/.env.local` into `process.env`, when Node can.
 *
 * One shared copy for every job a person runs by hand (golive-check,
 * verify-test-purchase, voice-samples, the three live checks). Each README
 * tells Boss to put keys in `web/.env.local`, and plain `node` does not read
 * that file, so every entry point calls this before it reads any key.
 *
 * `process.loadEnvFile` is built into Node 22, which this repo already needs
 * for TypeScript type stripping. No dotenv dependency. It never overwrites a
 * key that the shell already set. A missing file is the normal case on a
 * machine that keeps its keys in the shell, so every error is swallowed.
 *
 * Call it from an entry point only, never at import time (web/CLAUDE.md).
 */
import { join } from 'node:path';

/** `web/`, worked out from this file. */
const WEB_DIR = join(import.meta.dirname, '..');

export function loadLocalEnv(): void {
  try {
    const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
    if (typeof load === 'function') load.call(process, join(WEB_DIR, '.env.local'));
  } catch {
    // No file, or no permission. Both are fine: the shell may hold the keys.
  }
}
