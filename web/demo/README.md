# PolityPedia demo data and QA tooling

Fills the real Supabase project (ref `fkcuqwywxpvoxgzszhdq`) with clearly labelled
DEMO data so every screen shows content. Everything is named `[Demo]` or
`Demo: ...`. No secret lives in these files: keys are read from `web/.env.local`
at run time and never printed.

Run everything from `web/`. In Git Bash prefix route arguments with
`MSYS_NO_PATHCONV=1` (otherwise `/` becomes a Windows path).

## Needs

- `pg` (not a web dependency). `lib.cjs` looks for it with a normal require,
  then `$PG_MODULE`. On a fresh machine: `npm i --no-save pg`.
- For screenshots: the `puppeteer` package installed globally (`npm root -g`),
  Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`, and the dev
  server on http://localhost:3000 (`node node_modules/next/dist/bin/next dev -p 3000`).

## Seed

```
node demo/seed.cjs
```

Idempotent (deterministic ids; the demo teacher's content is wiped and
re-inserted in one transaction). Creates:

| Account | Role | Use |
|---|---|---|
| `95sandeepkumar95+teacher@gmail.com` | teacher, approved | owns all demo content |
| `95sandeepkumar95+admin@gmail.com` | admin | admin screens |
| `95sandeepkumar95+student@gmail.com` | student | QA student: follows, 4 saved, 1 finished practice attempt |
| `demo-pending@example.com` | teacher, pending | shows in the admin approval list |
| `demo-s1/s2/s3@example.com` | student | batch members and buyers for the payout rows |

Boss's real account `95sandeepkumar95@gmail.com` is never edited. It only gets
a follow, the same 4 saved questions and the same finished attempt. No plan and
no `set_access` is granted to the QA student or Boss, so the paywall shows.

Content: 1 mock set (2 tests, 20 questions, test 1 is the free sample), 2 live
papers (3 PDFs in storage bucket `papers`), 3 videos (placeholder YouTube ids),
3 notices, 1 batch (join code `DEMNET`), 2 ready AI explanations, 3 purchases,
3 ledger rows, 1 payout, 1 reconcile alert, teacher exam dates.

## Unseed

```
node demo/unseed.cjs
```

Deletes the 7 demo auth users (admin API), their rows, the storage PDFs, every
demo-tagged row, and Boss's seeded follow/saved/attempt rows. Boss's account row
and role stay untouched. Prints what is left as proof.

## Log in without email

```
node demo/qa-login.cjs student|teacher|admin
```

Admin `generate_link` (magiclink, no email is sent) -> `/auth/v1/verify` ->
builds the `pp_session` cookie exactly like `encodeSession()` in
`src/lib/auth/session.ts` and writes `cookie-<role>.json` to the scratchpad demo
folder (override with `QA_OUT_DIR`). Prints only `ok`. The access token lasts
about an hour; `shot.cjs` re-mints automatically after 40 minutes.

## Screenshot

```
MSYS_NO_PATHCONV=1 node demo/shot.cjs student /saved out.png mobile
MSYS_NO_PATHCONV=1 node demo/shot.cjs admin /admin/payouts out.png desktop
```

`mobile` = 390x844 @2x, `desktop` = 1280x900, full page. Prints the final path
so a redirect away from the requested route shows as `REDIRECTED`.
