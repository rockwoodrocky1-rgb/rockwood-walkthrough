-- Branch-only migration. Do not apply to the current shared test while it is in use.
-- Anonymous Auth sessions are invisible to field users: name + phone are self-reported
-- contact details, never proof of identity and never a cross-device lookup key.
alter table public.workspace_members drop constraint workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check check (role in ('owner','editor','viewer','contributor'));
create table public.field_contacts (
  user_id uuid primary key references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (length(trim(name)) between 2 and 100),
  phone text not null check (phone ~ '^\+?[0-9]{7,15}$'),
  updated_at timestamptz not null default now()
);
alter table public.field_contacts enable row level security;
revoke all on public.field_contacts from public, anon, authenticated;
grant select on public.field_contacts to authenticated;
create policy own_contact on public.field_contacts for select to authenticated using (user_id = (select auth.uid()));
create function public.register_field_contact(contact_name text, contact_phone text)
returns void language plpgsql security definer set search_path = '' as $$
declare workspace uuid; current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then raise exception 'A browser session is required'; end if;
  if length(trim(contact_name)) not between 2 and 100 or contact_phone !~ '^\+?[0-9]{7,15}$' then raise exception 'Invalid contact details'; end if;
  select id into strict workspace from public.workspaces where slug='rockwood-development';
  insert into public.workspace_members(workspace_id,user_id,role) values(workspace,current_user_id,'contributor') on conflict do nothing;
  insert into public.field_contacts(user_id,workspace_id,name,phone) values(current_user_id,workspace,trim(contact_name),contact_phone)
    on conflict(user_id) do update set name=excluded.name,phone=excluded.phone,updated_at=now();
end;
$$;
revoke all on function public.register_field_contact(text,text) from public, anon;
grant execute on function public.register_field_contact(text,text) to authenticated;

-- Existing company roles retain their existing permissions. Field contributors can
-- see shared project choices, but only their own visits, evidence and delivery state.
alter policy member_walkthroughs on public.walkthroughs using (
 exists(select 1 from public.workspace_members m where m.workspace_id=walkthroughs.workspace_id and m.user_id=(select auth.uid())
 and (m.role<>'contributor' or walkthroughs.created_by=m.user_id))
);
alter policy create_walkthrough on public.walkthroughs with check (
 created_by=(select auth.uid()) and exists(select 1 from public.workspace_members m where m.workspace_id=walkthroughs.workspace_id and m.user_id=(select auth.uid()) and m.role in ('owner','editor','contributor'))
);
alter policy edit_walkthrough on public.walkthroughs using (
 exists(select 1 from public.workspace_members m where m.workspace_id=walkthroughs.workspace_id and m.user_id=(select auth.uid()) and (m.role='owner' or (m.role in ('editor','contributor') and created_by=m.user_id)))
) with check (
 exists(select 1 from public.workspace_members m where m.workspace_id=walkthroughs.workspace_id and m.user_id=(select auth.uid()) and (m.role='owner' or (m.role in ('editor','contributor') and created_by=m.user_id)))
);
alter policy member_media_read on storage.objects using (
 bucket_id='walkthrough-media' and exists(select 1 from public.workspace_members m where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid())
 and (m.role<>'contributor' or (storage.foldername(name))[2]=m.user_id::text))
);
alter policy member_media_upload on storage.objects with check (
 bucket_id='walkthrough-media' and (storage.foldername(name))[2]=(select auth.uid())::text and exists(select 1 from public.workspace_members m where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid()) and m.role in ('owner','editor','contributor'))
);
alter policy member_delivery_status on public.report_deliveries using (
 exists(select 1 from public.workspace_members m where m.workspace_id=report_deliveries.workspace_id and m.user_id=(select auth.uid()) and
 (m.role<>'contributor' or exists(select 1 from public.walkthroughs w where w.workspace_id=report_deliveries.workspace_id and w.id=report_deliveries.walkthrough_id and w.created_by=m.user_id)))
);
alter policy member_report_pdf on storage.objects using (
 bucket_id='walkthrough-reports' and exists(select 1 from public.workspace_members m where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid()) and
 (m.role<>'contributor' or exists(select 1 from public.report_deliveries d where d.workspace_id=m.workspace_id and d.pdf_path=storage.objects.name)))
);

-- Freeze the self-reported contact from its server-side row, not a forged payload.
-- Members cannot mutate evidence paths to cause the PDF worker to read other visits.
create function private.validate_field_submission() returns trigger language plpgsql security definer set search_path = '' as $$
declare contact public.field_contacts; contributor boolean; photo jsonb; path text; prefix text;
begin
 select * into contact from public.field_contacts where user_id=new.created_by and workspace_id=new.workspace_id;
 if contact.user_id is not null then
   if TG_OP='UPDATE' and old.payload ? 'participant' then
     new.payload := jsonb_set(new.payload,'{participant}',old.payload->'participant');
   else
     new.payload := jsonb_set(new.payload,'{participant}',jsonb_build_object('name',contact.name,'phone',contact.phone));
   end if;
 end if;
 select exists(select 1 from public.workspace_members where workspace_id=new.workspace_id and user_id=new.created_by and role='contributor') into contributor;
 if contributor then
   if contact.user_id is null then raise exception 'Contact details are required'; end if;
   prefix := new.workspace_id::text || '/' || new.created_by::text || '/' || new.id || '/';
   for photo in select value from jsonb_array_elements(coalesce(new.payload->'photos','[]'::jsonb)) loop
     foreach path in array array[photo->'original'->>'path',photo->'model'->>'path'] loop
       if path is null or left(path,length(prefix))<>prefix or position('..' in path)>0 then raise exception 'Invalid photo path'; end if;
     end loop;
   end loop;
   if new.payload->'audio' is not null then
     path := new.payload->'audio'->>'path';
     if path is null or left(path,length(prefix))<>prefix or position('..' in path)>0 then raise exception 'Invalid audio path'; end if;
   end if;
 end if;
 if new.payload->>'language'='es' and new.payload->'report' is not null and new.payload->'report'->>'mode'<>'sample'
 and (new.payload->'report'->>'outputLanguage') is distinct from 'en' then raise exception 'Prepare the English report before delivery'; end if;
 return new;
end;
$$;
revoke all on function private.validate_field_submission() from public,anon,authenticated;
create trigger validate_field_submission before insert or update on public.walkthroughs for each row execute function private.validate_field_submission();

-- The read-only email-link endpoint reads exactly one authorized visit. Its server
-- key stays out of the browser; object buckets and the Data API remain private.
grant select on public.walkthroughs, public.projects to service_role;

-- One atomic daily budget for this testing workspace and a per-session budget.
-- This bounds paid requests even when field entry requires no verification.
create table private.ai_daily_usage (
  workspace_id uuid not null references public.workspaces(id),
  usage_date date not null,
  subject text not null,
  calls integer not null default 0,
  primary key(workspace_id,usage_date,subject)
);
alter table private.ai_daily_usage enable row level security;
revoke all on private.ai_daily_usage from public,anon,authenticated;
create function public.consume_field_ai_budget() returns boolean language plpgsql security definer set search_path = '' as $$
declare workspace uuid; user_calls integer; total_calls integer; current_user_id uuid := (select auth.uid());
begin
 select workspace_id into workspace from public.workspace_members where user_id=current_user_id and role in ('owner','editor','contributor') limit 1;
 if workspace is null then return false; end if;
 insert into private.ai_daily_usage values(workspace,current_date,'workspace',0) on conflict do nothing;
 select calls into total_calls from private.ai_daily_usage where workspace_id=workspace and usage_date=current_date and subject='workspace' for update;
 insert into private.ai_daily_usage values(workspace,current_date,current_user_id::text,0) on conflict do nothing;
 select calls into user_calls from private.ai_daily_usage where workspace_id=workspace and usage_date=current_date and subject=current_user_id::text for update;
 if total_calls>=100 or user_calls>=20 then return false; end if;
 update private.ai_daily_usage set calls=calls+1 where workspace_id=workspace and usage_date=current_date and subject in ('workspace',current_user_id::text);
 return true;
end;
$$;
revoke all on function public.consume_field_ai_budget() from public,anon;
grant execute on function public.consume_field_ai_budget() to authenticated;
