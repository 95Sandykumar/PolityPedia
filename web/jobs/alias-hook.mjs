/**
 * Resolve app-style imports for plain Node (issue 12-pdf-split-worker).
 *
 * The app is written for a bundler: `@/lib/...` for the `src/` alias, and no
 * file extension on a relative import (web/CLAUDE.md). Next.js and Vitest both
 * read that out of `tsconfig.json`; plain `node` does neither, and the PM2
 * worker is plain `node`.
 *
 * So this is a module resolve hook that teaches Node the same two rules:
 *
 *   `@/lib/split/types`  ->  <web>/src/lib/split/types.ts
 *   `./types`            ->  <same dir>/types.ts
 *
 * One small hook instead of a dependency, and the worker then runs exactly the
 * files the tests cover rather than a bundled second copy that could drift.
 * Node 22+ runs TypeScript by stripping the types, so there is no build step.
 *
 * Registered by `register-alias.mjs`, which PM2 and the `job:pdf-split` npm
 * script both load with `--import`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

/** The extensions a bundler would try, in the order it tries them. */
const TRIED = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx'];

/** The first of these that is really on disk, as a file URL, or null. */
function onDisk(base) {
  for (const href of [base, ...TRIED.map((ext) => base + ext)]) {
    let path;
    try {
      path = fileURLToPath(href);
    } catch {
      continue;
    }
    // A directory passes `existsSync`, so `/index.ts` has to be tried as its
    // own candidate rather than trusting the bare path.
    if (existsSync(path) && !path.endsWith('/') && !path.endsWith('\\')) {
      return pathToFileURL(path).href;
    }
  }
  return null;
}

export function resolve(specifier, context, next) {
  // `@/x` -> `src/x`.
  if (specifier.startsWith('@/')) {
    const found = onDisk(new URL(specifier.slice(2), SRC).href);
    if (found) return { url: found, shortCircuit: true };
    // Nothing matched: hand the original back so Node's own error names the
    // import the developer actually wrote.
    return next(specifier, context);
  }

  // `./x` and `../x`, which the source writes without an extension.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const found = onDisk(new URL(specifier, context.parentURL).href);
    if (found) return { url: found, shortCircuit: true };
  }

  return next(specifier, context);
}
