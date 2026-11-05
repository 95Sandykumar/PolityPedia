@DESIGN.md

# PolityPedia web app conventions

- Specs: `../PRD-PolityPedia-v1.md` and `../design.md`. UI rules: `DESIGN.md` (tokens only, no raw hex in components, light only).
- Run `npm test` and `npm run build` inside `web/`. Both must pass with NO environment variables set.
- Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests. No real network call and no real key in any test.
- Supabase and env access is lazy (read inside functions, never at import time), so the build works without env vars. Pages render a "not configured" state when keys are missing.
- SQL migrations live in `supabase/migrations/` and start with the issue number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table.
- DB tests use PGlite through the helper from issue 02.
- Every label a user sees exists in English and Hindi through `src/lib/i18n.ts` (modes `en | hi | both`, default `en`).
- Links use `prefetch={false}` (no viewport prefetch, B3).
- ESM imports use the `@/` alias for `src/`.
