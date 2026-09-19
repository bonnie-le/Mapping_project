

create table if not exists public.projects (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
    name        text not null default 'Untitled site',
    map_center  jsonb,                       -- {lat, lng}
    map_zoom    integer,
    settings    jsonb default '{}'::jsonb,   -- contour options, checkboxes
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists public.buildings (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
    project_id   uuid not null references public.projects (id) on delete cascade,
    local_id     text not null,
    name         text not null default 'Building',
    floor_height numeric(6,2) not null default 3.5,
    visible      boolean not null default true,
    sort_order   integer not null default 0,
    unique (project_id, local_id)
);

create table if not exists public.floor_plans (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
    project_id  uuid not null references public.projects (id) on delete cascade,
    building_id uuid not null references public.buildings (id) on delete cascade,
    local_id    text not null,
    name        text not null default 'Floor',
    file_name   text,
    level       integer not null default 1,
    elevation   numeric(8,2),                -- null = derive from storey height
    image_path  text,                        -- object path inside the bucket
    img_w       integer not null,
    img_h       integer not null,
    -- Three corners are enough for a full affine placement; the fourth is
    -- br = tr + bl - tl. Stored as plain numerics so they are easy to query.
    tl_lat      double precision not null,
    tl_lng      double precision not null,
    tr_lat      double precision not null,
    tr_lng      double precision not null,
    bl_lat      double precision not null,
    bl_lng      double precision not null,
    opacity     numeric(3,2) not null default 0.70,
    unique (project_id, local_id)
);

create table if not exists public.datasets (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
    project_id   uuid not null references public.projects (id) on delete cascade,
    floor_id     uuid references public.floor_plans (id) on delete set null,
    local_id     text not null,
    file_name    text not null,
    note         text,
    visible      boolean not null default true,
    is_outdoor   boolean not null default false,
    lat_key      text,
    lng_key      text,
    rsrp_key     text,
    point_count  integer not null default 0,
    data_path    text,                       -- parsed rows as JSON in Storage
    unique (project_id, local_id)
);

create index if not exists projects_user_idx     on public.projects (user_id, updated_at desc);
create index if not exists buildings_project_idx on public.buildings (project_id);
create index if not exists floors_project_idx    on public.floor_plans (project_id);
create index if not exists datasets_project_idx  on public.datasets (project_id);

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
    before update on public.projects
    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- The frontend uses the anon key, so RLS is the only thing standing
-- between one account's data and another's. user_id defaults to
-- auth.uid() on the server; the client never sends it.
-- ---------------------------------------------------------------------

alter table public.projects    enable row level security;
alter table public.buildings   enable row level security;
alter table public.floor_plans enable row level security;
alter table public.datasets    enable row level security;

drop policy if exists "own projects"    on public.projects;
drop policy if exists "own buildings"   on public.buildings;
drop policy if exists "own floor_plans" on public.floor_plans;
drop policy if exists "own datasets"    on public.datasets;

create policy "own projects" on public.projects
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "own buildings" on public.buildings
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "own floor_plans" on public.floor_plans
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "own datasets" on public.datasets
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Storage bucket for plan images and parsed scan rows
-- Every object lives under <user_id>/..., and the policies below check
-- that first path segment against auth.uid().
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('mapping-files', 'mapping-files', false)
on conflict (id) do nothing;

drop policy if exists "own files read"   on storage.objects;
drop policy if exists "own files write"  on storage.objects;
drop policy if exists "own files update" on storage.objects;
drop policy if exists "own files delete" on storage.objects;

create policy "own files read" on storage.objects
    for select to authenticated
    using (bucket_id = 'mapping-files'
           and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own files write" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'mapping-files'
                and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own files update" on storage.objects
    for update to authenticated
    using (bucket_id = 'mapping-files'
           and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own files delete" on storage.objects
    for delete to authenticated
    using (bucket_id = 'mapping-files'
           and (storage.foldername(name))[1] = auth.uid()::text);
