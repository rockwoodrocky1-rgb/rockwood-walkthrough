-- Run as the SQL editor's database role. All test users/records roll back.
begin;
create temporary table invitation_snapshot on commit drop as select count(*) as total from private.workspace_invitations where email = 'rockwoodrocky1@gmail.com';
insert into auth.users (id, email, email_confirmed_at, is_anonymous)
values ('f0000000-0000-4000-8000-000000000001', 'rls-owner@example.invalid', now(), false),
       ('f0000000-0000-4000-8000-000000000002', 'rls-outsider@example.invalid', now(), false);
insert into public.workspace_members (workspace_id, user_id, role)
select id, 'f0000000-0000-4000-8000-000000000001', 'owner' from public.workspaces where slug = 'rockwood-development';

set local role authenticated;
set local request.jwt.claim.sub = 'f0000000-0000-4000-8000-000000000001';
set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare workspace uuid; affected integer;
begin
  select id into workspace from public.workspaces where slug = 'rockwood-development';
  if workspace is null then raise exception 'FAIL: member workspace invisible'; end if;
  if (select count(*) from public.projects where workspace_id = workspace) <> 3 then raise exception 'FAIL: projects invisible'; end if;
  insert into public.walkthroughs (workspace_id, id, project_id, started_at, payload)
  values (workspace, 'rls-transaction-test', 'coral-gables', now(), '{"notes":"test"}');
  update public.walkthroughs set payload = '{"notes":"updated"}', revision = 2 where id = 'rls-transaction-test' and revision = 1;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL: owner update denied'; end if;
  update public.walkthroughs set payload = '{"notes":"stale"}', revision = 2 where id = 'rls-transaction-test' and revision = 1;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'FAIL: stale write succeeded'; end if;
  begin
    update public.walkthroughs set created_by = 'f0000000-0000-4000-8000-000000000002' where id = 'rls-transaction-test';
    raise exception 'FAIL: ownership update succeeded';
  exception when insufficient_privilege then null; end;
end;
$$;

-- Spoofing the invitation email in JWT claims must not claim the actual owner's
-- invitation: the helper checks the verified email from auth.users instead.
set local request.jwt.claim.sub = 'f0000000-0000-4000-8000-000000000002';
set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-000000000002","role":"authenticated","email":"rockwoodrocky1@gmail.com"}';
select public.claim_workspace_access();
do $$
begin
  if (select count(*) from public.workspace_members) <> 0 then raise exception 'FAIL: outsider claimed membership'; end if;
  if (select count(*) from public.projects) <> 0 then raise exception 'FAIL: outsider sees projects'; end if;
  if (select count(*) from public.walkthroughs) <> 0 then raise exception 'FAIL: outsider sees visits'; end if;
  begin
    insert into public.workspaces (slug,name) values ('not-allowed','Not allowed');
    raise exception 'FAIL: outsider created workspace';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename in ('workspaces','workspace_members','projects','walkthroughs') and not rowsecurity)
    then raise exception 'FAIL: row security disabled'; end if;
  if has_table_privilege('anon','public.walkthroughs','select') then raise exception 'FAIL: anonymous table access'; end if;
  if (select public from storage.buckets where id = 'walkthrough-media') then raise exception 'FAIL: public media bucket'; end if;
  if (select count(*) from private.workspace_invitations where email = 'rockwoodrocky1@gmail.com') <> (select total from invitation_snapshot)
    then raise exception 'FAIL: owner invitation consumed'; end if;
end;
$$;
rollback;
select 'PASS: member access, outsider isolation, immutable ownership, revision checks, private media, and invitation protection. Test data rolled back.' as result;
