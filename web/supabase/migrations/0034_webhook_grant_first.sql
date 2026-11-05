-- 0034_webhook_grant_first.sql  (issue 34-webhook-grant-first)
--
-- A CRASH MUST NOT LEAVE A PAYING STUDENT LOCKED OUT.
--
-- Issues 27 and 28 put the de-dupe FIRST, which is what A2 asks for, and did
-- it in TWO round trips from the route:
--
--   1. record_payment_event(event_id)   -- commits "seen it"
--   2. grant_purchase(order_id, fee)    -- opens the set
--
-- The 2026-11-05 review found the hole between 1 and 2. Kill the process
-- there (a Vercel timeout is enough) and the event id is committed while the
-- set is still shut. Razorpay's retry is then a "duplicate", the route answers
-- 200, and the student who paid Rs 399 never gets in. For
-- `subscription.charged` a whole month disappears. `forget_payment_event()`
-- was the answer and it only runs if the process is still alive to run it,
-- which is the one thing a timeout takes away.
--
-- THE FIX IS AN ORDERING, NOT A NEW TABLE. Three of the four actions are
-- already idempotent through their own status checks, so they are safe to run
-- FIRST, with no de-dupe gate in front of them, and the event id is written
-- afterwards for audit:
--
--   grant_purchase()     refuses anything that is not `created`
--   refund_purchase()    refuses anything already `refunded`
--   mark_subscription()  sets a status; setting it twice is the same state
--
-- A crash between the action and the audit row is then HARMLESS: the retry
-- runs the same idempotent action, gets FALSE, and writes the audit row.
--
-- `charge_subscription()` was the exception: it added one month PER CALL, so
-- running it twice was a free month. It cannot be made idempotent by a status
-- check, because month two is a legitimate second call. So it now takes the
-- DE-DUPE KEY ITSELF and does the insert and the month in ONE transaction,
-- which removes the gap rather than compensating for it.
--
-- THE KEY COMES FROM THE SIGNED BODY. `charged:<payment id>`, and not the
-- `x-razorpay-event-id` header. The header is NOT covered by the HMAC, so
-- anybody who can replay a genuine signed body can also invent a new header
-- value, and under the old code that bought another month. The payment id is
-- inside the signed bytes and is new every cycle, which is exactly the shape a
-- de-dupe key needs.
--
-- FOUR GUARDS COME WITH IT, all of them money:
--
--  * AN EARLY REFUND. `refund.created` can arrive before `payment.captured`.
--    0027 refused to refund a `created` row, in case a capture was a second
--    behind. That was backwards: a refund IMPLIES a capture, so the row moves
--    `created -> refunded`, and `grant_purchase()`'s existing "must be
--    `created`" check then stops the late capture from reopening it.
--
--  * THE AMOUNT. `grant_purchase()` now takes the paise and the currency from
--    the signed body and refuses when they disagree with our own
--    `purchases.amount_inr`, or when the currency is not INR. F-G2 said the
--    price always comes from our database; this is the other half, which is
--    checking that what arrived is what we asked for.
--
--  * THE PLAN. `charge_subscription()` takes the plan the charge was for and
--    refuses when it is not the plan the subscription row was opened for. A
--    Rs 100 AI charge must never extend a Rs 500 Pro plan.
--
--  * EVERY REFUSAL IS A 200, NOT A 500. A refusal files a `reconcile_alerts`
--    row (A6) and answers FALSE, so the route replies 2xx and Razorpay stops.
--    An event that can never succeed must not be retried for hours; it must be
--    put in front of a human.
--
-- WHAT IS NOT HERE. The coupon limit, the payout race and the nightly
-- reconcile job are tickets 30 to 33 and 35. This file touches the webhook
-- ordering, the charge de-dupe, the early refund, the amount check and the
-- plan check, and nothing else.
--
-- Same rules as 0027 to 0029: `security definer`, `set search_path`, revoked
-- from public / anon / authenticated, granted to `service_role` alone inside a
-- role guard so the PGlite test harness still applies the file.

-- ---------------------------------------------------------------------------
-- Three more kinds of alert.
--
-- `reconcile_alerts` (0029) was written for the nightly job, which knows four
-- kinds of mismatch. The webhook can now see three more, and they go in the
-- SAME table on purpose: Boss has one list of money problems, not two.
--
--   `currency_mismatch` money arrived in something that is not rupees.
--   `plan_mismatch`     a charge for a plan the subscription is not on.
--   `bad_event`         an event that can never succeed however often it is
--                       delivered: an order id longer than our column, a fee
--                       that is not a fee, a charge with no payment id to
--                       de-dupe on.
--
-- `amount_mismatch` is reused as-is: a webhook-side amount disagreement is
-- the same problem the nightly job names, and the `(kind, subject)` UNIQUE
-- keeps the two sightings apart because the subjects differ (`order:<id>`
-- here, the payment id there).
-- ---------------------------------------------------------------------------
alter table public.reconcile_alerts
  drop constraint if exists reconcile_alerts_kind_check;

alter table public.reconcile_alerts
  add constraint reconcile_alerts_kind_check
  check (kind in (
    'no_purchase',
    'not_paid',
    'amount_mismatch',
    'no_payment',
    'currency_mismatch',
    'plan_mismatch',
    'bad_event'
  ));

comment on column public.reconcile_alerts.kind is
  'no_purchase (money taken, no row), not_paid (row never turned paid), amount_mismatch (both paid, different amounts), no_payment (our row says paid, the gateway has nothing), currency_mismatch (not rupees), plan_mismatch (a charge for another plan), bad_event (an event that can never succeed). The last three are written by the webhook (issue 34).';

-- ---------------------------------------------------------------------------
-- grant_purchase(order_id, fee, paid_paise, paid_currency)
--
-- Everything 0027 did, plus the two new checks, and it is now the FIRST thing
-- the webhook calls.
--
-- WHY DROP AND RECREATE RATHER THAN ADD AN OVERLOAD. Two functions named
-- `grant_purchase` with a 2-argument call that fits both is an ambiguous
-- function call, and PostgREST sends named arguments, so the ambiguity would
-- be a runtime 300 on a live sale. The two new parameters default to NULL, so
-- `grant_purchase($1, $2)` still means exactly what it meant before.
--
-- BOTH NEW CHECKS SKIP ON NULL, and that is deliberate. An `order.paid` body
-- with no payment entity carries no amount, and a missing number must not shut
-- a sale that really happened. The nightly reconcile (A6) is what catches a
-- silent mismatch; this check catches a loud one.
--
-- THE REFUSALS RETURN FALSE, NOT A RAISE. A raise is a 500 and a 500 is a
-- Razorpay retry, and retrying a payment that came in the wrong currency will
-- never make it rupees. FALSE plus an alert row is "this needs a human", which
-- is the truth.
--
-- The order of the checks is the order of the writes: nothing at all is
-- written until both have passed, so a refused grant leaves the purchase
-- `created` and the set shut.
-- ---------------------------------------------------------------------------
drop function if exists public.grant_purchase(text, numeric);

create function public.grant_purchase(
  order_id      text,
  fee           numeric default 0,
  paid_paise    bigint  default null,
  paid_currency text    default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted     text := btrim(coalesce(order_id, ''));
  money      text := upper(btrim(coalesce(paid_currency, '')));
  bought     public.purchases;
  owner      uuid;
  for_exam   uuid;
  pct        integer;
  exam_day   date;
  open_until timestamptz;
  v_wanted   bigint;
  v_gross    numeric(12,2);
  v_gst      numeric(12,2);
  v_fee      numeric(12,2);
  v_net      numeric(12,2);
  v_teacher  numeric(12,2);
  touched    integer;
begin
  if wanted = '' then
    return false;
  end if;

  -- FOR UPDATE, and it is the first statement for a reason: it serialises two
  -- overlapping deliveries of the same payment. The second one blocks here,
  -- and when it wakes up the status is 'paid', so it falls out below.
  select p.* into bought
  from public.purchases p
  where p.razorpay_order_id = wanted
  for update;

  -- Not ours. A webhook for another project's order, or a test event. Nothing
  -- to do, and nothing wrong.
  if not found then
    return false;
  end if;

  -- A3. 'paid' is a repeat delivery and 'refunded' is a capture that arrived
  -- after the refund. Reopening a refunded row would hand back a set we have
  -- already paid the student back for, and issue 34 makes that path REAL: a
  -- refund now moves a `created` row straight to `refunded`.
  --
  -- This is checked before the amount, so a plain second delivery is a quiet
  -- FALSE and not an alert.
  if bought.status <> 'created' then
    return false;
  end if;

  -- THE CURRENCY. Razorpay sells in rupees for us and nothing else, and a set
  -- priced Rs 399 that is paid 399 of something else is not paid.
  if money <> '' and money <> 'INR' then
    perform public.record_reconcile_alert(
      'currency_mismatch',
      left('order:' || wanted, 160),
      wanted,
      (bought.amount_inr::bigint * 100),
      paid_paise
    );
    return false;
  end if;

  -- THE AMOUNT. Our row is the authority (F-G2): `amount_inr` was decided by
  -- `start_set_purchase()` out of `mock_sets.price_inr` and the coupon, never
  -- from a request. Paise, because that is the unit the gateway speaks and
  -- converting before comparing is how a rounding argument starts.
  v_wanted := bought.amount_inr::bigint * 100;
  if paid_paise is not null and paid_paise <> v_wanted then
    perform public.record_reconcile_alert(
      'amount_mismatch',
      left('order:' || wanted, 160),
      wanted,
      v_wanted,
      paid_paise
    );
    return false;
  end if;

  update public.purchases p
  set status = 'paid'
  where p.id = bought.id
    and p.status = 'created';

  get diagnostics touched = row_count;
  -- Belt and braces behind the lock: if the row moved under us, stop rather
  -- than write a ledger row for a sale we did not complete.
  if touched <> 1 then
    return false;
  end if;

  -- V19: the share is on MOCK SETS, and `purchases.set_id` only ever points at
  -- one. The teacher and the exam both come from the set, not from the request.
  select s.teacher_id, s.exam_id into owner, for_exam
  from public.mock_sets s
  where s.id = bought.set_id;

  select t.revenue_share_pct into pct
  from public.teachers t
  where t.user_id = owner;

  -- X2: "Until the teacher's next exam date for that exam + 30 days. If no
  -- date set: 12 months."
  select te.next_exam_date into exam_day
  from public.teacher_exams te
  where te.teacher_id = owner
    and te.exam_id = for_exam;

  open_until := case
    when exam_day is not null and (exam_day + 30) > current_date
      then (exam_day + 30)::timestamptz
    else now() + public.access_fallback()
  end;

  insert into public.set_access (user_id, set_id, source, valid_until)
  values (bought.user_id, bought.set_id, 'purchase', open_until)
  on conflict (user_id, set_id, source)
    -- GREATEST, never a plain overwrite. The A4 zero-price path writes
    -- 'infinity' (0026), and a re-run must not shorten access somebody has
    -- already paid for.
    do update set valid_until = greatest(set_access.valid_until, excluded.valid_until);

  -- The split, exactly as 0027 worked it out.
  v_gross := bought.amount_inr::numeric;
  v_gst   := round(v_gross - v_gross / public.gst_divisor(), 2);
  v_fee   := least(greatest(round(coalesce(fee, 0), 2), 0), v_gross - v_gst);
  v_net   := v_gross - v_gst - v_fee;

  pct := coalesce(pct, 0);
  v_teacher := round(v_net * pct / 100, 2);

  insert into public.teacher_ledger (
    teacher_id, purchase_id, gross, gst, gateway_fee, net, share_pct,
    teacher_amount, platform_amount
  )
  values (
    owner, bought.id, v_gross, v_gst, v_fee, v_net, pct,
    v_teacher, v_net - v_teacher
  )
  on conflict (purchase_id) do nothing;

  -- 0026 deliberately left this to the webhook: "an abandoned checkout must
  -- not burn a code". The sale is real now, so the use is spent.
  if bought.coupon is not null then
    update public.coupons c
    set used = c.used + 1
    where c.code = bought.coupon
      and c.used < c.max_uses;
  end if;

  return true;
end;
$$;

comment on function public.grant_purchase(text, numeric, bigint, text) is
  'A captured Razorpay payment, in ONE transaction keyed on the purchase (A5): created -> paid (forward only, A3), set_access for X2''s window, one teacher_ledger row with the share copied at sale time (X3), and the coupon use spent. IDEMPOTENT, so the webhook calls it BEFORE recording the event id (issue 34): a crash in between is harmless. Refuses, with a reconcile_alerts row and no write at all, when the paid paise disagree with purchases.amount_inr or the currency is not INR. paid_paise / paid_currency NULL means the gateway did not say, which is not a refusal. TRUE only when this call did the work. service_role only. Issues 27-razorpay-webhook-ledger and 34-webhook-grant-first.';

-- ---------------------------------------------------------------------------
-- refund_purchase(order_id) -- now accepts a refund that beats its capture.
--
-- 0027 refused to refund a `created` row, reasoning that a capture might be a
-- second behind. The review turned that round: Razorpay does not refund money
-- it never took, so a `refund.created` for a `created` row of ours means the
-- capture webhook is the one that is late or lost. Leaving the row `created`
-- means the late capture OPENS A SET THE STUDENT HAS BEEN PAID BACK FOR.
--
-- So `created` and `paid` both move to `refunded`, and the guard against the
-- late capture is `grant_purchase()`'s existing "must be `created`" check,
-- which is enforced in the UPDATE's own WHERE behind the row lock.
--
-- The row is only ever found BY ITS ORDER ID, so a row that reaches this
-- function always has an order attached: the A4 zero-price path has no order
-- id and cannot be refunded here. That is the "that has an order attached"
-- half of the definition of done, and it is true by construction.
--
-- A `created` refund writes NO ledger row and deletes NO access, because
-- neither exists: `grant_purchase()` never ran. The delete below is a no-op on
-- that path and is left unconditional on purpose, so there is one code path
-- and not two.
-- ---------------------------------------------------------------------------
create or replace function public.refund_purchase(order_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(order_id, ''));
  bought  public.purchases;
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  select p.* into bought
  from public.purchases p
  where p.razorpay_order_id = wanted
  for update;

  if not found then
    return false;
  end if;

  -- A3, forward only. 'refunded' is the only status left to refuse: we have
  -- already done this, and doing it twice would delete an access row a later
  -- batch grant may have put back.
  if bought.status = 'refunded' then
    return false;
  end if;

  update public.purchases p
  set status = 'refunded'
  where p.id = bought.id
    -- Re-checked behind the lock, in the WHERE and not in an IF.
    and p.status in ('created', 'paid');

  get diagnostics touched = row_count;
  if touched <> 1 then
    return false;
  end if;

  -- The purchase's own access, and nothing else. A batch or admin grant for
  -- the same set survives, because `set_access`'s primary key includes the
  -- source (0016).
  delete from public.set_access a
  where a.user_id = bought.user_id
    and a.set_id = bought.set_id
    and a.source = 'purchase';

  return true;
end;
$$;

comment on function public.refund_purchase(text) is
  'A refunded Razorpay payment: created OR paid -> refunded (forward only, A3) and the purchase''s own set_access row deleted, leaving any batch or admin grant alone. A refund that beats its capture is accepted, because a refund implies a capture, and grant_purchase() then refuses the late capture (issue 34). FALSE when the row is already refunded or is not ours, so the webhook can still reply 2xx. The ledger row is kept: a ledger is append-only. service_role only. Issues 27-razorpay-webhook-ledger and 34-webhook-grant-first.';

-- ---------------------------------------------------------------------------
-- charge_subscription(subscription_id, charge_key, type, payload, plan)
--
-- ONE SQL function that inserts the de-dupe row AND applies the month, in one
-- transaction. That is the whole point: there is no longer a "between" for a
-- crash to land in.
--
-- The insert is the FIRST statement, and it is the lock. `payment_events`'s
-- primary key serialises two overlapping deliveries of one charge: the second
-- blocks on the key, wakes up to a conflict, gets `row_count = 0` and answers
-- FALSE without touching the entitlement. No status check could do that,
-- because month two is a legitimate second call.
--
-- `charge_key` IS THE SIGNED BODY'S PAYMENT ID, prefixed: `charged:<pay id>`.
-- Not the `x-razorpay-event-id` header, which is outside the HMAC and so is
-- attacker-chosen on a replay. `src/lib/purchases/webhook.ts` builds it and
-- always sends it.
--
-- `charge_key` NULL means "the caller is doing its own de-dupe". That is kept
-- for the 0028 database tests, which drive `record_payment_event()` by hand
-- exactly the way the old route did. The webhook never passes NULL.
--
-- `charged_plan` is OUR plan word ('ai' / 'pro'), not Razorpay's plan id. The
-- id lives in an environment variable and Postgres cannot read one, so the
-- store maps id -> word and sends the word. An id we cannot place arrives as
-- something that matches neither plan, which is a mismatch, which is the safe
-- answer. NULL means "the gateway did not say", and that is not a refusal.
-- ---------------------------------------------------------------------------
drop function if exists public.charge_subscription(text);

create function public.charge_subscription(
  subscription_id text,
  charge_key      text    default null,
  new_type        text    default 'subscription.charged',
  new_payload     jsonb   default '{}'::jsonb,
  charged_plan    text    default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(subscription_id, ''));
  key     text := btrim(coalesce(charge_key, ''));
  kind    text := btrim(coalesce(new_type, ''));
  for_plan text := btrim(coalesce(charged_plan, ''));
  sub     public.subscriptions;
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  -- Only our own code calls this, and only our own code can get the key
  -- wrong. A raise rather than a FALSE, the same call `mark_subscription()`
  -- makes for a status it does not know: a silent FALSE here would throw away
  -- a month somebody paid for.
  if key <> '' and length(key) > 120 then
    raise exception 'a subscription charge key is too long to de-dupe'
      using errcode = 'PP422';
  end if;

  -- THE DE-DUPE, AND THE LOCK. One statement, so two deliveries racing each
  -- other cannot both be told "new", and it is inside the same transaction as
  -- the month below, so neither can exist without the other.
  if key <> '' then
    insert into public.payment_events (event_id, type, payload)
    values (
      key,
      case when kind = '' then 'unknown' else left(kind, 80) end,
      coalesce(new_payload, '{}'::jsonb)
    )
    on conflict (event_id) do nothing;

    get diagnostics touched = row_count;
    -- Seen it. This exact charge has already been paid for.
    if touched <> 1 then
      return false;
    end if;
  end if;

  -- FOR UPDATE: it serialises anything else holding this subscription, so the
  -- month is added on top of the committed value and not on top of a stale
  -- read.
  select s.* into sub
  from public.subscriptions s
  where s.razorpay_subscription_id = wanted
  for update;

  -- Not ours: another project's subscription, or a Razorpay test event.
  if not found then
    return false;
  end if;

  -- THE PLAN. A Rs 100 AI charge must never extend a Rs 500 Pro plan, and a
  -- plan id we could not place is not something to guess about. The alert
  -- plus FALSE means the route answers 200 and a human looks at it, rather
  -- than Razorpay retrying a charge that can never be right.
  if for_plan <> '' and for_plan <> sub.plan then
    perform public.record_reconcile_alert(
      'plan_mismatch',
      left(case when key = '' then 'sub:' || wanted else key end, 160),
      null,
      null,
      null
    );
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

comment on function public.charge_subscription(text, text, text, jsonb, text) is
  'One paid month for a Razorpay subscription, de-dupe row AND month in ONE transaction (issue 34), so a crash cannot leave one without the other. charge_key is the SIGNED body''s payment id as charged:<pay id>, never the unsigned x-razorpay-event-id header, so a replay under a new header buys nothing; NULL means the caller de-dupes itself. Refuses, with a reconcile_alerts row, when charged_plan is not the plan the subscription was opened for. status -> active and entitlements.valid_until = greatest(paid-until, now) + plan_period(), so a renewal stacks and a lapsed plan restarts today. Writes NO teacher_ledger row (V19). FALSE for a repeat, an unknown or a cancelled subscription so the webhook can still reply 2xx. service_role only. Issues 28-plan-subscriptions and 34-webhook-grant-first.';

-- ---------------------------------------------------------------------------
-- Who may call them: the webhook, and nothing else.
--
-- DROP took the old grants with it, so both recreated functions start life
-- with Postgres's default EXECUTE to PUBLIC plus Supabase's default
-- privileges for `anon` and `authenticated`. Left in place,
-- `select grant_purchase('order_x', 0, 39900, 'INR')` from any signed-in
-- student's own token is a free mock set, and `charge_subscription('sub_mine',
-- 'charged:anything')` is a free month of Pro every time they tap it.
--
-- `service_role` is granted INSIDE a role guard, because that role is Supabase
-- platform config and does not exist in the PGlite test harness
-- (web/CLAUDE.md). The harness runs migrations as the owner, which needs no
-- grant, so the tests still drive the real functions.
-- ---------------------------------------------------------------------------
revoke all on function public.grant_purchase(text, numeric, bigint, text)
  from public, anon, authenticated;
revoke all on function public.refund_purchase(text)
  from public, anon, authenticated;
revoke all on function public.charge_subscription(text, text, text, jsonb, text)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.grant_purchase(text, numeric, bigint, text) to service_role';
    execute 'grant execute on function public.refund_purchase(text) to service_role';
    execute 'grant execute on function public.charge_subscription(text, text, text, jsonb, text) to service_role';
  end if;
end
$$;
