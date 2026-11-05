-- 0035_reconcile_visible.sql  (issue 35-reconcile-visible)
--
-- ONE CHANGE: a fifth alert kind.
--
-- 0029 built `reconcile_alerts` with everything this issue's screen needs:
-- `resolved_at` is already there, and `reconcile_alerts_admin_all` is already
-- `for all` with `is_admin()` in both `using` and `with check`, so an admin can
-- already select the open rows and set `resolved_at` with their own token. The
-- new `/admin/alerts` page needs no new table, no new column and no new policy,
-- and this file deliberately adds none of them.
--
-- WHAT IT DOES ADD, and why it is money.
--
-- `supabase-reconcile-store.ts` DROPS a purchase row whose shape it cannot
-- read, which is correct (a guessed `paid` hides a real mismatch, a guessed
-- amount invents one). Until this issue it dropped them SILENTLY. So the one
-- state where our own data has gone strange was the one state the job said
-- nothing about, and every dropped row quietly turns into a wrong conclusion:
-- a dropped purchase makes its captured payment look like `no_purchase`.
--
-- The count now files an alert, and an alert needs a kind. The kind list is a
-- CHECK constraint on purpose (0029: "a typo in the job would otherwise write
-- `no_purchse` and sit in the table looking like a different problem"), so the
-- list has to be widened here rather than in TypeScript.
--
--   `unreadable_purchase`  the nightly job read our `purchases` and could not
--                          parse N rows. Not a gateway mismatch at all: a
--                          problem with OUR data, which makes every other
--                          conclusion of that night suspect.
--
-- `subject` for this kind is `purchases:<the window start>`, so one strange
-- night is one line and a re-run of the same night writes nothing, exactly
-- like the other four kinds.
--
-- NOT HERE, on purpose: no Telegram or email push. The repo has no admin
-- notify path for jobs (checked: nothing under `web/jobs/` or `web/src/` sends
-- one), and 0029 already says pushing an alert to Boss is the ClaudeClaw side,
-- later. The alert row plus `/admin/alerts` is the whole delivery in v1.

-- `drop` then `add`, because Postgres has no "alter check constraint". Both
-- statements are guarded so a re-run of the migration file is free, which is
-- what the PGlite harness and a repeated `supabase db push` both do.
alter table public.reconcile_alerts
  drop constraint if exists reconcile_alerts_kind_check;

alter table public.reconcile_alerts
  add constraint reconcile_alerts_kind_check
  check (kind in (
    'no_purchase',
    'not_paid',
    'amount_mismatch',
    'no_payment',
    'unreadable_purchase'
  ));

comment on column public.reconcile_alerts.kind is
  'no_purchase (money taken, no row), not_paid (row never turned paid), amount_mismatch (both paid, different amounts), no_payment (our row says paid, the gateway has nothing), unreadable_purchase (the job could not parse N of our own purchase rows, so the rest of that night is suspect).';
