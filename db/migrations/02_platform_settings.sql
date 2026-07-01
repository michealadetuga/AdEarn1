-- Configurable platform task limits (admin-adjustable at runtime)

create table if not exists public.platform_settings (
  id integer primary key default 1 check (id = 1),
  daily_ad_limit integer not null default 20 check (daily_ad_limit between 1 and 500),
  daily_ip_ad_limit integer not null default 20 check (daily_ip_ad_limit between 1 and 500),
  ad_cooldown_seconds integer not null default 90 check (ad_cooldown_seconds between 0 and 3600),
  daily_social_task_limit integer not null default 5 check (daily_social_task_limit between 0 and 100),
  updated_at timestamptz default now(),
  updated_by uuid references public.users(id)
);

insert into public.platform_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.social_task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  task_id text not null,
  points_earned integer not null,
  proof text,
  completed_at timestamptz default now(),
  unique (user_id, task_id)
);

create index if not exists social_task_completions_user_completed_at_idx
  on public.social_task_completions(user_id, completed_at desc);

alter table public.platform_settings enable row level security;
alter table public.social_task_completions enable row level security;

create policy social_task_completions_select_own
  on public.social_task_completions
  for select
  using (auth.uid() = user_id);

create or replace function public.get_today_social_task_count(target_user_id uuid)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.social_task_completions
  where user_id = target_user_id
    and completed_at >= date_trunc('day', now());
$$;
