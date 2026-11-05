-- 0028_subscriptions.sql  (issue 28-plan-subscriptions)
--
-- THE MONTHLY PLAN, END TO END IN POSTGRES. V18 sells three things: Free, the
-- AI plan at Rs 100 a month and Pro at Rs 500 a month. Issue 21 built
-- `entitlements` and the `can_use()` gate and said in its own header that a
-- row is written "by an admin (this issue) or by the Razorpay webhook (a later
-- issue, running with the service role)". This file is that later issue.
--
-- Almost all of it is SQL, for the same reason issue 27 was. A webhook is the
-- one request in this app that arrives MORE THAN ONCE: Razorpay retries until
-- it gets a 2xx, two deliveries can overlap, and a cancellation can land
-- before the charge it follows. A route handler that reads `valid_until`,
-- adds a month and writes it back has a gap between the read and the write,
-- and in that gap a student loses a month they paid for, or gets two for one.
-- So the whole move is ONE statement inside ONE transaction, holding the
-- subscription row's lock (A5).
--
-- WHAT IS HERE
--   * `subscriptions`              -- one row per attempt to subscribe, and the
--                                    ONLY map from a Razorpay subscription id
--                                    back to a user and a plan.
--   * `plan_price_inr()`           -- V18's two prices, in one place (F-G2).
--   * `plan_period()`              -- one month. One place, so a renewal and a
--                                    first charge can never disagree.
--   * `start_plan_subscription()`  -- the student's own call, from Me > Plans.
--   * `attach_subscription_id()`   -- the Razorpay id back onto our row.
--   * `charge_subscription()`      -- `subscription.charged`: one more month.
--   * `mark_subscription()`        -- activated / cancelled / halted.
--
-- WHY A `subscriptions` TABLE AT ALL, when `entitlements` already holds the
-- paid-until date. Because the webhook is not a signed-in user. It arrives
-- with a Razorpay subscription id and NOTHING else: no cookie, no token, no
-- user id. Without a stored row there is no honest way to learn whose plan
-- `sub_test_xyz` is, and the only alternative is trusting a user id out of the
-- webhook body, which is a free Pro plan for anybody who can POST.
--
-- V19, AND IT IS THE POINT OF THE LAST TEST IN `test/subscriptions.test.ts`.
-- "Teacher share is on MOCK SETS only." Plan money is the platform's, so
-- `charge_subscription()` writes NO `teacher_ledger` row. Not a small row and
-- not a zero row: issue 27's reconcile and the payout report both read
-- `teacher_ledger` as "one row per paid purchase", and a plan has no purchase.
--
-- WHAT A CANCELLATION DOES NOT DO. It does not touch `valid_until`. The
-- student paid for this month, so this month is theirs; `can_use()` already
-- shuts by itself the moment the date passes. Deleting the row on cancel would
-- take back a month somebody paid for, which is a refund we did not give.
--
-- SCOPE GUARD, from the issue: no proration and no plan switching mid-cycle.
-- Pro on top of AI is two subscriptions and two bills, which is honest and is
-- two lines of code. Swapping one for the other with a part-month credit is
-- neither, and is not v1.
--
-- THE REFUSAL CODES are 0026's, so `src/lib/purchases/types.ts` maps them with
-- no new table:
--   PP401  not signed in
--   PP404  no such plan, or no such subscription of yours
--   PP409  you already have that plan
--   PP422  the Razorpay subscription id is not valid

-- ---------------------------------------------------------------------------
-- The two constants. Functions and not a table, deliberately.
--
-- A price table would need its own RLS, its own write policy and its own
-- "which row is current" question, and would let a bad row sell Pro for Re 1.
-- V18 names two prices and a monthly period; when they change, this file
-- changes, in review, with a migration. `plan_price_inr` is also the only
-- place an amount is decided, which is F-G2 ("the price always comes from our
-- database, never from the phone") made true by construction.
-- ---------------------------------------------------------------------------
create or replace function public.plan_price_inr(plan text)
returns integer
language sql
immutable
as $$
  select case btrim(coalesce(plan, ''))
           when 'ai'  then 100
           when 'pro' then 500
           -- NULL and not 0. A plan we do not sell has no price, and 0 would
           -- be a free Pro plan for a typo.
           else null
         end
$$;

comment on function public.plan_price_inr(text) is
  'V18 plan prices in whole rupees: ai = 100, pro = 500, anything else = NULL. The only place a plan amount is decided (F-G2). Issue 28-plan-subscriptions.';

create or replace function public.plan_period()
returns interval
language sql
immutable
as $$
  select interval '1 month'
$$;

comment on function public.plan_period() is
  'One billing cycle. V18 sells monthly plans only. Issue 28-plan-subscriptions.';

-- ---------------------------------------------------------------------------
-- subscriptions
--
-- One row per attempt. A `created` row with no Razorpay id is an abandoned
-- checkout and is HARMLESS: it unlocks nothing, it is never charged, and
-- nothing reads it. That is the same call 0026 made for `purchases`, and it is
-- why there is no unique index on (user_id, plan).
--
-- A UNIQUE INDEX ON ACTIVE ROWS WAS CONSIDERED AND REJECTED. It would make
-- `charge_subscription()` raise on the day a student somehow holds two paid
-- subscriptions to one plan, and a raise there means a 500, which means
-- Razorpay retries for hours and the student's month never lands. The guard
-- belongs where a human can see it: `start_plan_subscription()` refuses to
-- start a second one (PP409), and that is the only path the UI has.
--
-- `razorpay_subscription_id` IS unique, because it is the webhook's key. Two
-- rows claiming one Razorpay subscription is the one shape that would make
-- `charge_subscription()` ambiguous.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users (id) on delete cascade,
  plan                     text        not null,
  -- The rupees POSTGRES quoted when the student tapped Subscribe. Copied at
  -- start time, the same reasoning as `teacher_ledger.share_pct`: a later
  -- price change must not rewrite what somebody agreed to pay.
  amount_inr               integer     not null,
  status                   text        not null default 'created',
  razorpay_subscription_id text,
  created_at               timestamptz not null default now(),

  constraint subscriptions_plan_check   check (plan in ('ai', 'pro')),

  -- created  -- started, not yet paid. Abandoned checkouts live here forever.
  -- active   -- Razorpay says it is live.
  -- cancelled-- the student (or we) stopped it. TERMINAL.
  -- halted   -- Razorpay gave up collecting. Can come back with a charge.
  constraint subscriptions_status_check
    check (status in ('created', 'active', 'cancelled', 'halted')),

  -- Must be a real price. A zero or negative subscription is a bug, and V18's
  -- free tier is the ABSENCE of a row, never a Rs 0 one.
  constraint subscriptions_amount_check check (amount_inr > 0),

  -- Same ceiling shape as `purchases.razorpay_order_id` in 0026.
  constraint subscriptions_rzp_check
    check (
      razorpay_subscription_id is null
      or (razorpay_subscription_id = btrim(razorpay_subscription_id)
          and length(razorpay_subscription_id) between 1 and 80)
    )
);

comment on table public.subscriptions is
  'One Razorpay plan subscription per row. The only map from a Razorpay subscription id back to a user and a plan, which is what lets an unauthenticated webhook know whose month to extend. RLS: read your own; only the SECURITY DEFINER functions write. Issue 28-plan-subscriptions.';
comment on column public.subscriptions.amount_inr is
  'Rupees quoted by plan_price_inr() at start time. A later price change does not rewrite it.';
comment on column public.subscriptions.razorpay_subscription_id is
  'Razorpay''s own id. NULL until attach_subscription_id(). The webhook''s only key, so it is unique.';
comment on column public.subscriptions.status is
  'created -> active -> cancelled (terminal). halted is Razorpay giving up on collection; a later charge resumes it.';

create unique index if not exists subscriptions_rzp_idx
  on public.subscriptions (razorpay_subscription_id)
  where razorpay_subscription_id is not null;

-- The lookup `start_plan_subscription()` makes: "does this student already
-- have this plan running?"
create index if not exists subscriptions_user_plan_idx
  on public.subscriptions (user_id, plan, status);

alter table public.subscriptions enable row level security;

-- A student sees their own subscriptions, so Me > Plans can say "Pro, active".
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using (auth.uid() = user_id);

-- An admin reads and writes every row: that is support.
create policy subscriptions_admin_all on public.subscriptions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- THERE IS NO INSERT, UPDATE OR DELETE POLICY FOR A STUDENT, on purpose, and
-- it is the same reasoning 0026 gives for `purchases`: a student who could
-- insert their own row could insert `status = 'active'`, and the webhook
-- trusts this table to say whose plan an id belongs to. The two functions
-- below are SECURITY DEFINER and are the whole write surface.

-- ---------------------------------------------------------------------------
-- start_plan_subscription(plan) -- the student taps Subscribe.
--
-- Returns the row id and the rupees, so the route can ask Razorpay for a
-- subscription with OUR number. The caller sends a plan name and nothing else:
-- there is no amount in the signature, so there is no amount to validate and
-- no amount to forget to validate (F-G2).
--
-- SECURITY DEFINER because `subscriptions` has no insert policy for a student.
-- It writes `auth.uid()` and never a parameter, so it cannot be aimed at
-- somebody else's account.
-- ---------------------------------------------------------------------------
create or replace function public.start_plan_subscription(for_plan text)
returns table (subscription_id uuid, amount_inr integer, status text)
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  buyer  uuid := auth.uid();
  wanted text := btrim(coalesce(for_plan, ''));
  price  integer;
  fresh  public.subscriptions;
begin
  if buyer is null then
    raise exception 'sign in to subscribe to a plan'
      using errcode = 'PP401';
  end if;

  price := public.plan_price_inr(wanted);
  if price is null then
    raise exception 'that plan does not exist'
      using errcode = 'PP404';
  end if;

  -- Already paying for it. No proration and no switching mid-cycle (scope
  -- guard), so the only honest answer is "you have it".
  if exists (
    select 1 from public.subscriptions s
    where s.user_id = buyer
      and s.plan = wanted
      and s.status = 'active'
  ) then
    raise exception 'you already have that plan'
      using errcode = 'PP409';
  end if;

  insert into public.subscriptions (user_id, plan, amount_inr)
  values (buyer, wanted, price)
  returning * into fresh;

  return query select fresh.id, fresh.amount_inr, fresh.status;
end;
$$;

comment on function public.start_plan_subscription(text) is
  'Open one plan subscription for the signed-in student and quote the price from plan_price_inr() (F-G2). PP401 not signed in, PP404 no such plan, PP409 you already have it. Issue 28-plan-subscriptions.';

grant execute on function public.start_plan_subscription(text) to authenticated;

-- ---------------------------------------------------------------------------
-- attach_subscription_id(subscription, subscription_id) -- SINGLE SHOT.
--
-- `razorpay_subscription_id is null` is in the UPDATE's own WHERE, not in an
-- IF above it. A1: the check and the write are one statement, so two taps that
-- both created a Razorpay subscription cannot both stick, and our row can
-- never point at two subscriptions. The second one answers "not found" and the
-- route refuses to open the checkout.
--
-- `status = 'created'` is in the same WHERE: an id must not be swapped onto a
-- subscription that is already live and collecting money.
-- ---------------------------------------------------------------------------
create or replace function public.attach_subscription_id(
  subscription    uuid,
  subscription_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  buyer   uuid := auth.uid();
  wanted  text := btrim(coalesce(subscription_id, ''));
  touched integer;
begin
  if buyer is null then
    raise exception 'sign in to subscribe to a plan'
      using errcode = 'PP401';
  end if;

  if wanted = '' or length(wanted) > 80 then
    raise exception 'subscription id is not valid'
      using errcode = 'PP422';
  end if;

  update public.subscriptions s
  set razorpay_subscription_id = wanted
  where s.id = subscription
    and s.user_id = buyer
    and s.status = 'created'
    and s.razorpay_subscription_id is null;

  get diagnostics touched = row_count;

  if touched <> 1 then
    -- Somebody else's row, a row that already has an id, or no such row. All
    -- three are the same sentence to a student, and none of them says which.
    raise exception 'subscription not found'
      using errcode = 'PP404';
  end if;

  return true;
end;
$$;

comment on function public.attach_subscription_id(uuid, text) is
  'Point one of your own created subscriptions at a Razorpay subscription id, once and only once (A1). PP404 if it is not yours, not created, or already attached. Issue 28-plan-subscriptions.';

grant execute on function public.attach_subscription_id(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- charge_subscription(subscription_id) -- `subscription.charged`: one month.
--
-- ONE TRANSACTION, keyed on the subscription row and holding its lock (A5),
-- for exactly the reason in this file's header: read-then-write on
-- `valid_until` loses a month under two overlapping deliveries.
--
-- In order:
--   1. find our subscription from the Razorpay id, FOR UPDATE,
--   2. refuse a cancelled one (A3: cancelled is terminal),
--   3. status -> active, which is also how a halted one resumes,
--   4. `entitlements.valid_until` = GREATEST(what is paid for, now) + a month.
--
-- STEP 4 IS THE WHOLE ISSUE. `greatest(..., now())` is what makes a renewal
-- STACK: a student paid up to 3 Dec who is charged on 3 Nov ends up at 3 Jan,
-- not 3 Dec. And when the plan already lapsed, `now()` wins and the month
-- starts today rather than from a date in the past, so a late retry does not
-- sell a month that is already over.
--
-- NO LEDGER ROW. V19: the teacher share is on mock sets, and this is platform
-- money. See the header.
--
-- DE-DUPE IS NOT HERE, and that is deliberate. `payment_events` and
-- `record_payment_event()` (0027) are the de-dupe, and the webhook calls them
-- FIRST, so a replayed delivery never reaches this function. Putting a second
-- event-id check in here would mean two tables answering the same question
-- and eventually disagreeing.
--
-- Returns TRUE only when this call added a month. An unknown id and a
-- cancelled subscription both answer FALSE, and the route still replies 200:
-- a webhook for another project's subscription is normal, and a 500 would buy
-- a retry storm and no fix.
-- ---------------------------------------------------------------------------
create or replace function public.charge_subscription(subscription_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted text := btrim(coalesce(subscription_id, ''));
  sub    public.subscriptions;
begin
  if wanted = '' then
    return false;
  end if;

  -- FOR UPDATE, and it is the first statement: it serialises two overlapping
  -- deliveries, so the second one adds its month on top of the first instead
  -- of on top of the value it read before the first committed.
  select s.* into sub
  from public.subscriptions s
  where s.razorpay_subscription_id = wanted
  for update;

  -- Not ours: another project's subscription, or a Razorpay test event.
  -- Nothing to do, and nothing wrong.
  if not found then
    return false;
  end if;

  -- A3. Cancelled is terminal. A charge that lands after a cancellation is
  -- either a race or a mistake on Razorpay's side, and buying a month for a
  -- plan the student has stopped is money we would have to give back.
  if sub.status = 'cancelled' then
    return false;
  end if;

  update public.subscriptions s
  set status = 'active'
  where s.id = sub.id
    -- Re-checked behind the lock: if it was cancelled under us, stop.
    and s.status <> 'cancelled';

  insert into public.entitlements (user_id, plan, valid_until, source)
  values (sub.user_id, sub.plan, now() + public.plan_period(), 'razorpay')
  on conflict (user_id, plan) do update
    set valid_until = greatest(public.entitlements.valid_until, now())
                      + public.plan_period(),
        source = 'razorpay';

  return true;
end;
$$;

comment on function public.charge_subscription(text) is
  'One paid month for a Razorpay subscription, in ONE transaction holding the subscription row (A5): status -> active, and entitlements.valid_until = greatest(paid-until, now) + plan_period(), so a renewal stacks and a lapsed plan restarts today. Writes NO teacher_ledger row (V19). FALSE for an unknown or cancelled subscription so the webhook can still reply 2xx. service_role only. Issue 28-plan-subscriptions.';

-- ---------------------------------------------------------------------------
-- mark_subscription(subscription_id, new_status) -- activated / cancelled /
-- halted.
--
-- The three events that move the subscription and NOT the money.
--
--   activated -> 'active'.   Razorpay sends it before the first charge. It
--                            grants NOTHING: the month is bought by
--                            `subscription.charged`, and granting here would
--                            hand out a free month to a subscription whose
--                            first collection then fails.
--   cancelled -> 'cancelled'. `valid_until` IS NOT TOUCHED. The student paid
--                            for this month; `can_use()` shuts on its own the
--                            moment the date passes. That IS the definition of
--                            done for this issue.
--   halted    -> 'halted'.   Razorpay gave up collecting. Same rule: the month
--                            already paid for stays.
--
-- Forward only (A3): nothing leaves 'cancelled'. A reactivation after a cancel
-- is a NEW subscription with a new Razorpay id, which is what Razorpay does
-- too.
--
-- Returns TRUE only when this call moved the row. An unknown id or a cancelled
-- row answers FALSE and the route still replies 200.
-- ---------------------------------------------------------------------------
create or replace function public.mark_subscription(
  subscription_id text,
  new_status      text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(subscription_id, ''));
  moving  text := btrim(coalesce(new_status, ''));
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  -- Only the three a webhook can ask for. 'created' is not one: a live
  -- subscription must not be walked back to "never paid". A raise and not a
  -- FALSE, because this one can only come from OUR code calling it wrongly.
  if moving not in ('active', 'cancelled', 'halted') then
    raise exception 'subscription status is not valid'
      using errcode = 'PP422';
  end if;

  update public.subscriptions s
  set status = moving
  where s.razorpay_subscription_id = wanted
    -- A3, in the WHERE and not in an IF: cancelled is terminal.
    and s.status <> 'cancelled';

  get diagnostics touched = row_count;
  return touched = 1;
end;
$$;

comment on function public.mark_subscription(text, text) is
  'Move one subscription to active, cancelled or halted and touch NO entitlement: a cancelled plan keeps the month it paid for, and can_use() shuts by itself at valid_until. Forward only, so cancelled is terminal (A3). PP422 for any other status. service_role only. Issue 28-plan-subscriptions.';

-- ---------------------------------------------------------------------------
-- Who may call the two webhook functions: the webhook, and nothing else.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase's default
-- privileges add `anon` and `authenticated`. Both are revoked here. Left in
-- place, `select charge_subscription('sub_mine')` from any signed-in student's
-- own token is a free Pro plan every time they tap it.
--
-- `service_role` is granted INSIDE a guard, because that role is Supabase
-- platform config and does not exist in the PGlite test harness
-- (web/CLAUDE.md). The harness runs migrations as the owner, which needs no
-- grant, so the tests still drive the real functions.
-- ---------------------------------------------------------------------------
revoke all on function public.charge_subscription(text) from public, anon, authenticated;
revoke all on function public.mark_subscription(text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.charge_subscription(text) to service_role';
    execute 'grant execute on function public.mark_subscription(text, text) to service_role';
  end if;
end
$$;

-- The two constants are safe to read: a price and a billing period are not
-- secrets, and Me > Plans draws both.
grant execute on function public.plan_price_inr(text) to authenticated;
grant execute on function public.plan_period() to authenticated;
