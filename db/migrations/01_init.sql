create extension if not exists pgcrypto;

create or replace function public.generate_referral_code()
returns text
language plpgsql
as $$
declare
  code text;
begin
  loop
    code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
    exit when not exists (select 1 from public.users where referral_code = code);
  end loop;
  return code;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text unique not null,
  phone text,
  account_number text,
  bank_name text,
  bank_code text,
  account_name text,
  balance_points integer default 0,
  total_earned integer default 0,
  total_withdrawn integer default 0,
  referral_code text unique not null default public.generate_referral_code(),
  referred_by uuid references public.users(id),
  is_verified boolean default false,
  is_banned boolean default false,
  is_admin boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  ad_network text not null check (ad_network in ('adsterra', 'monetag')),
  ad_unit_id text not null,
  ad_type text not null check (ad_type in ('video', 'banner')),
  points_reward integer default 50,
  duration_seconds integer not null,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ad_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  ad_id uuid references public.ads(id) not null,
  started_at timestamptz default now(),
  completed_at timestamptz,
  watch_duration integer,
  completed boolean default false,
  ip_address text,
  device_fingerprint text,
  points_earned integer default 0,
  created_at timestamptz default now()
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  amount_naira integer not null,
  points_spent integer not null,
  bank_name text not null,
  bank_code text not null,
  account_number text not null,
  account_name text not null,
  paystack_transfer_code text,
  status text default 'pending' check (status in ('pending','paid','rejected')),
  rejection_reason text,
  created_at timestamptz default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid references public.users(id) not null,
  referred_id uuid references public.users(id) not null,
  signup_bonus_paid boolean default false,
  firstwatch_bonus_paid boolean default false,
  total_bonus_points integer default 0,
  created_at timestamptz default now(),
  unique (referrer_id, referred_id)
);

create table if not exists public.fraud_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  flag_type text not null,
  details jsonb,
  resolved boolean default false,
  created_at timestamptz default now()
);

alter table public.users enable row level security;
alter table public.ads enable row level security;
alter table public.ad_views enable row level security;
alter table public.withdrawals enable row level security;
alter table public.referrals enable row level security;
alter table public.fraud_flags enable row level security;

drop policy if exists users_select_own on public.users;
drop policy if exists users_update_own on public.users;
drop policy if exists ad_views_insert_own on public.ad_views;
drop policy if exists ad_views_select_own on public.ad_views;
drop policy if exists withdrawals_insert_own on public.withdrawals;
drop policy if exists withdrawals_select_own on public.withdrawals;
drop policy if exists referrals_select_own on public.referrals;
drop policy if exists ads_select_active_authenticated on public.ads;

create policy users_select_own on public.users for select using (auth.uid() = id);
create policy users_update_own on public.users for update using (auth.uid() = id) with check (auth.uid() = id);
create policy ad_views_insert_own on public.ad_views for insert with check (auth.uid() = user_id);
create policy ad_views_select_own on public.ad_views for select using (auth.uid() = user_id);
create policy withdrawals_insert_own on public.withdrawals for insert with check (auth.uid() = user_id);
create policy withdrawals_select_own on public.withdrawals for select using (auth.uid() = user_id);
create policy referrals_select_own on public.referrals for select using (auth.uid() = referrer_id or auth.uid() = referred_id);
create policy ads_select_active_authenticated on public.ads for select to authenticated using (is_active = true);

create or replace function public.get_today_view_count(target_user_id uuid)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.ad_views
  where user_id = target_user_id
    and completed = true
    and completed_at >= date_trunc('day', now());
$$;

create or replace function public.add_user_points(target_user_id uuid, points_delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
  set balance_points = balance_points + points_delta,
      total_earned = case when points_delta > 0 then total_earned + points_delta else total_earned end
  where id = target_user_id;
end;
$$;

create or replace function public.request_withdrawal(
  target_user_id uuid,
  amount integer,
  points_cost integer,
  bank text,
  bank_code_value text,
  acct_number text,
  acct_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  withdrawal_id uuid;
  current_balance integer;
begin
  select balance_points into current_balance from public.users where id = target_user_id for update;
  if current_balance is null then
    raise exception 'User not found';
  end if;
  if current_balance < points_cost then
    raise exception 'Insufficient points balance';
  end if;
  if amount < 1000 then
    raise exception 'Minimum withdrawal is NGN 1,000';
  end if;

  update public.users
  set balance_points = balance_points - points_cost,
      total_withdrawn = total_withdrawn + amount,
      bank_name = bank,
      bank_code = bank_code_value,
      account_number = acct_number,
      account_name = acct_name
  where id = target_user_id;

  insert into public.withdrawals (user_id, amount_naira, points_spent, bank_name, bank_code, account_number, account_name, status)
  values (target_user_id, amount, points_cost, bank, bank_code_value, acct_number, acct_name, 'pending')
  returning id into withdrawal_id;

  return withdrawal_id;
end;
$$;

create index if not exists ad_views_user_completed_at_idx on public.ad_views(user_id, completed_at desc) where completed = true;
create index if not exists ad_views_ip_completed_at_idx on public.ad_views(ip_address, completed_at desc) where completed = true;
create index if not exists withdrawals_user_created_at_idx on public.withdrawals(user_id, created_at desc);
create index if not exists fraud_flags_unresolved_idx on public.fraud_flags(resolved, created_at desc);
