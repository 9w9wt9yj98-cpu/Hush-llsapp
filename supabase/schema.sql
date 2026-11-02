-- Kylskåpsdörren: databasschema för Supabase.
-- Kör hela filen en gång i Supabase → SQL Editor. Den går att köra igen utan att något försvinner.

create table if not exists public.items (
  collection text   not null check (collection in ('shopping','meals','recipes','chores','budget','events')),
  id         text   not null,
  data       jsonb  not null default '{}'::jsonb,
  ts         bigint not null default 0,      -- klientens tid (ms) för skrivningen, används för att känna igen egna ekon
  device     text   not null default '',     -- slumpat id per telefon, samma syfte
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create or replace function public.items_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items for each row execute function public.items_touch();

-- Bara inloggade (hushållets gemensamma användare) får läsa och skriva. Den publika nyckeln ensam räcker inte.
alter table public.items enable row level security;
drop policy if exists "household can read"   on public.items;
drop policy if exists "household can write"  on public.items;
create policy "household can read"  on public.items for select to authenticated using (true);
create policy "household can write" on public.items for all    to authenticated using (true) with check (true);

revoke all on public.items from anon;
grant select, insert, update, delete on public.items to authenticated;

-- Realtid: ändringar på en telefon syns direkt på den andra.
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;
