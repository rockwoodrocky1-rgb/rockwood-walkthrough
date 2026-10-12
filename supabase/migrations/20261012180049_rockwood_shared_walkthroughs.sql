-- Client-owned testing workspace. No anonymous access to project records or media.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members(user_id);
create table private.workspace_invitations (
  workspace_id uuid not null references public.workspaces(id),
  email text not null check (email = lower(email)),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (workspace_id, email)
);
create table public.projects (
  workspace_id uuid not null references public.workspaces(id),
  id text not null,
  name text not null,
  type text not null,
  stage text not null,
  areas text[] not null default '{}',
  image text not null,
  number text not null,
  is_sample boolean not null default false,
  primary key (workspace_id, id)
);
create table public.walkthroughs (
  workspace_id uuid not null references public.workspaces(id),
  id text not null check (length(id) between 1 and 100),
  project_id text not null,
  created_by uuid not null default auth.uid() references auth.users(id),
  started_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 500000),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id)
);
create index walkthroughs_recent on public.walkthroughs(workspace_id, started_at desc) where archived_at is null;
create index walkthroughs_project on public.walkthroughs(workspace_id, project_id);
create index walkthroughs_creator on public.walkthroughs(created_by);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.walkthroughs enable row level security;
alter table private.workspace_invitations enable row level security;
revoke all on public.workspaces, public.workspace_members, public.projects, public.walkthroughs from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.projects, public.walkthroughs to authenticated;
grant insert (workspace_id, id, project_id, started_at, payload) on public.walkthroughs to authenticated;
grant update (payload, revision, archived_at) on public.walkthroughs to authenticated;
create policy own_membership on public.workspace_members for select to authenticated using (user_id = (select auth.uid()));
create policy member_workspace on public.workspaces for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = workspaces.id and m.user_id = (select auth.uid()))
);
create policy member_projects on public.projects for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = projects.workspace_id and m.user_id = (select auth.uid()))
);
create policy member_walkthroughs on public.walkthroughs for select to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = walkthroughs.workspace_id and m.user_id = (select auth.uid()))
);
create policy create_walkthrough on public.walkthroughs for insert to authenticated with check (
  created_by = (select auth.uid()) and exists (
    select 1 from public.workspace_members m where m.workspace_id = walkthroughs.workspace_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'editor')
  )
);
create policy edit_walkthrough on public.walkthroughs for update to authenticated using (
  exists (select 1 from public.workspace_members m where m.workspace_id = walkthroughs.workspace_id
    and m.user_id = (select auth.uid()) and (m.role = 'owner' or (m.role = 'editor' and created_by = m.user_id)))
) with check (
  exists (select 1 from public.workspace_members m where m.workspace_id = walkthroughs.workspace_id
    and m.user_id = (select auth.uid()) and (m.role = 'owner' or (m.role = 'editor' and created_by = m.user_id)))
);

-- Keep ownership immutable and reject lost updates even from direct API clients.
create function private.validate_walkthrough_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.workspace_id <> old.workspace_id or new.id <> old.id or new.created_by <> old.created_by
    or new.project_id <> old.project_id or new.started_at <> old.started_at then
    raise exception 'Walkthrough ownership cannot change';
  end if;
  if new.revision <> old.revision + 1 then raise exception 'Walkthrough revision conflict'; end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.validate_walkthrough_update() from public, anon, authenticated;
create trigger validate_walkthrough_update before update on public.walkthroughs for each row execute function private.validate_walkthrough_update();

-- The definer helper is narrowly limited to claiming a pre-approved invitation for
-- the CURRENT, verified Auth user. Never trusts browser-supplied user metadata.
create function private.claim_workspace_access() returns void language plpgsql security definer set search_path = '' as $$
declare verified_email text;
begin
  select lower(email) into verified_email from auth.users
    where id = (select auth.uid()) and email_confirmed_at is not null and is_anonymous = false;
  if verified_email is null then raise exception 'A verified account is required'; end if;
  insert into public.workspace_members (workspace_id, user_id, role)
    select workspace_id, (select auth.uid()), role from private.workspace_invitations where email = verified_email
    on conflict do nothing;
  delete from private.workspace_invitations where email = verified_email;
end;
$$;
revoke all on function private.claim_workspace_access() from public, anon;
grant execute on function private.claim_workspace_access() to authenticated;
create function public.claim_workspace_access() returns void language sql security invoker set search_path = '' as $$
  select private.claim_workspace_access();
$$;
revoke all on function public.claim_workspace_access() from public, anon;
grant execute on function public.claim_workspace_access() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('walkthrough-media', 'walkthrough-media', false, 15000000,
  array['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'video/mp4']);
create policy member_media_read on storage.objects for select to authenticated using (
  bucket_id = 'walkthrough-media' and exists (
    select 1 from public.workspace_members m where m.workspace_id::text = (storage.foldername(name))[1]
      and m.user_id = (select auth.uid())
  )
);
create policy member_media_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'walkthrough-media' and (storage.foldername(name))[2] = (select auth.uid())::text and exists (
    select 1 from public.workspace_members m where m.workspace_id::text = (storage.foldername(name))[1]
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'editor')
  )
);
-- Media is immutable. Archiving hides visits without permanently deleting their files.

with workspace as (
  insert into public.workspaces (slug, name) values ('rockwood-development', 'Rockwood Development') returning id
)
insert into private.workspace_invitations (workspace_id, email, role)
  select id, 'rockwoodrocky1@gmail.com', 'owner' from workspace;
insert into public.projects (workspace_id, id, name, type, stage, areas, image, number, is_sample)
select w.id, p.* from public.workspaces w cross join (values
  ('coral-gables', 'Coral Gables Residence', 'Residential renovation', 'Finishing stage', array['Kitchen','Primary Bathroom','Living Room','Exterior'], '/images/residence.webp', '01', true),
  ('doral-office', 'Doral Office Buildout', 'Commercial interiors', 'Active construction', array['Reception','Conference Room','Open Office','Restrooms'], '/images/office.webp', '02', true),
  ('pinecrest', 'Pinecrest Custom Home', 'New construction', 'Framing / rough-in', array['First Floor','Second Floor','Garage','Exterior'], '/images/house.webp', '03', true)
) as p(id, name, type, stage, areas, image, number, is_sample) where w.slug = 'rockwood-development';
