/**
 * Turn the `@/` resolver on (issue 12-pdf-split-worker).
 *
 * A resolve hook has to live in its own module and be registered from a
 * second one, because Node runs hooks on a separate thread. Loaded with
 * `node --import ./jobs/register-alias.mjs`, which is what the
 * `job:pdf-split` npm script and `ecosystem.config.cjs` both do.
 */
import { register } from 'node:module';

register('./alias-hook.mjs', import.meta.url);
