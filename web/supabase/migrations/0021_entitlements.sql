-- 0021_entitlements.sql  (issue 21-plans-entitlements)
--
-- V18 plans: Free, AI plan Rs 100/month (AI only), Pro Rs 500/month
-- (AI + notes + score vs cut-off). Mock sets are sold separately and are not
-- a plan, so they never appear here.
--
-- One row per (user, plan). Re-granting the same plan moves `valid_until`
-- instead of piling up rows, which is what the primary key is for.
--
-- There is no insert, update or delete policy for a student on purpose: a plan
-- is granted by an admin (this issue) or by the Razorpay webhook (a later
-- issue, running with the service role). A student may only read their own row.

create table if not exists public.entitlements (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  plan        text        not null,
  valid_until timestamptz not null,
  source      text        not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, plan),
  constraint entitlements_plan_check   check (plan   in ('ai', 'pro')),
  constraint entitlements_source_check check (source in ('admin', 'razorpay'))
);

comment on table public.entitlements is
  'Paid plan per user (ai = Rs 100, pro = Rs 500). RLS: read own row; only an admin writes. Issue 21-plans-entitlements.';
comment on column public.entitlements.valid_until is
  'The plan is live while valid_until > now(). Past that the row is kept as history and unlocks nothing.';
comment on column public.entitlements.source is
  'admin = granted by hand for testing or support. razorpay = a paid subscription.';

-- Reading a plan is cheap and happens on every AI call, so index the lookup
-- can_use() makes. The primary key already covers (user_id, plan); this adds
-- the "is anything still valid for this user" shape.
create index if not exists entitlements_user_valid_idx
  on public.entitlements (user_id, valid_until desc);

-- Is the CALLER an admin? Used by the write policy below.
--
-- SECURITY DEFINER so the lookup is not itself filtered by the profiles
-- policies. It only ever looks at auth.uid()'s own row and returns a boolean,
-- so it leaks nothing about anybody else.
--
-- `create or replace` on purpose: this is the shared admin check for the whole
-- app. A later slice that needs it should call it, not redefine it.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
$$;

comment on function public.is_admin() is
  'True when the signed-in caller has profiles.role = admin. Issue 21-plans-entitlements.';

grant execute on function public.is_admin() to authenticated;

alter table public.entitlements enable row level security;

-- A student sees their own plan, so the app can show "AI plan until 3 Dec".
create policy entitlements_select_own on public.entitlements
  for select to authenticated
  using (auth.uid() = user_id);

-- An admin reads and writes every row: that is the grant/end screen.
-- `for all` covers select, insert, update and delete in one policy.
create policy entitlements_admin_all on public.entitlements
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- The one gate the whole app asks.
--
-- SECURITY INVOKER (the default) on purpose: it reads public.entitlements
-- through the caller's own RLS. So a student can only ask about themselves,
-- an admin can ask about anybody, and the service role (webhooks, cron) sees
-- everything. No separate permission model to keep in sync.
--
-- plpgsql, not sql, so the parameters can be qualified as `can_use.user_id`
-- and `can_use.feature`. In a LANGUAGE SQL body an unqualified `user_id`
-- would silently resolve to the COLUMN, making the filter always true.
--
-- X6: Pro has the same 30-new-AI-explanations-a-day cap as the AI plan, so
-- this function answers "may you use the feature at all", never "how many
-- are left today". The daily counter is its own slice.
create or replace function public.can_use(user_id uuid, feature text)
returns boolean
language plpgsql
stable
as $$
declare
  allowed boolean;
begin
  select exists (
    select 1
    from public.entitlements e
    where e.user_id = can_use.user_id
      and e.valid_until > now()
      and case can_use.feature
            -- AI explanations: both paid plans.
            when 'ai'       then e.plan in ('ai', 'pro')
            -- Notes and score vs cut-off: Pro only (V18).
            when 'notes'    then e.plan = 'pro'
            when 'analysis' then e.plan = 'pro'
            -- Anything else, including NULL, is locked. Never an error, so a
            -- typo in a route handler fails closed.
            else false
          end
  )
  into allowed;

  return allowed;
end;
$$;

comment on function public.can_use(uuid, text) is
  'Plan gate: ai = AI or Pro, notes/analysis = Pro only, expired or unknown = false. Reads through the caller RLS. Issue 21-plans-entitlements.';

grant execute on function public.can_use(uuid, text) to authenticated;
