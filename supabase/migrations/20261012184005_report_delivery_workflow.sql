-- The outbox is committed in the SAME transaction as the report. Closing a
-- browser cannot lose a delivery. Only the trusted worker can mutate jobs.
create table public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  walkthrough_id text not null,
  report_id text not null check (length(report_id) between 1 and 100),
  revision integer not null,
  snapshot jsonb not null,
  project_name text not null,
  is_sample_project boolean not null,
  status text not null default 'queued' check (status in ('queued','processing','sent','needs_attention','cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  send_started_at timestamptz,
  email_envelope jsonb,
  pdf_path text,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(workspace_id, report_id),
  foreign key(workspace_id, walkthrough_id) references public.walkthroughs(workspace_id,id)
);
create index report_deliveries_due on public.report_deliveries(next_attempt_at) where status in ('queued','processing');
create index report_deliveries_walkthrough on public.report_deliveries(workspace_id,walkthrough_id);
alter table public.report_deliveries enable row level security;
revoke all on public.report_deliveries from public, anon, authenticated;
grant select(id,workspace_id,walkthrough_id,report_id,revision,status,pdf_path,last_error,created_at,sent_at) on public.report_deliveries to authenticated;
grant all on public.report_deliveries to service_role;
create policy member_delivery_status on public.report_deliveries for select to authenticated using (
 exists(select 1 from public.workspace_members m where m.workspace_id = report_deliveries.workspace_id and m.user_id = (select auth.uid()))
);

create function private.queue_report_delivery() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if new.archived_at is null and new.payload->'report'->>'mode' in ('manual','live')
   and length(new.payload->'report'->>'id') between 1 and 100 then
  insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,snapshot,project_name,is_sample_project)
  select new.workspace_id,new.id,new.payload->'report'->>'id',new.revision,to_jsonb(new),p.name,p.is_sample
  from public.projects p where p.workspace_id=new.workspace_id and p.id=new.project_id
  on conflict(workspace_id,report_id) do nothing;
 end if;
 return new;
end;
$$;
revoke all on function private.queue_report_delivery() from public,anon,authenticated;
create trigger report_delivery_outbox after insert or update on public.walkthroughs
for each row execute function private.queue_report_delivery();

-- One job per invocation, with a lease and SKIP LOCKED for concurrent workers.
-- Never replay an uncertain send after the provider's 24-hour deduplication window.
create function public.claim_report_delivery(job_id uuid default null)
returns setof public.report_deliveries language plpgsql set search_path = '' as $$
declare selected_id uuid;
begin
 update public.report_deliveries set status='needs_attention',last_error='Email confirmation needs an administrator review. Automatic resending is paused.'
 where status in ('queued','processing') and send_started_at < now()-interval '23 hours'
 and (lease_until is null or lease_until < now());
 select d.id into selected_id from public.report_deliveries d
 where (job_id is null or d.id=job_id) and d.next_attempt_at<=now()
 and (d.status='queued' or (d.status='processing' and d.lease_until<now()))
 order by d.created_at for update skip locked limit 1;
 if selected_id is null then return; end if;
 return query update public.report_deliveries set status='processing',attempts=attempts+1,
   lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes'
 where id=selected_id returning *;
end;
$$;
revoke all on function public.claim_report_delivery(uuid) from public,anon,authenticated;
grant execute on function public.claim_report_delivery(uuid) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('walkthrough-reports','walkthrough-reports',false,10000000,array['application/pdf']);
create policy member_report_pdf on storage.objects for select to authenticated using (
 bucket_id='walkthrough-reports' and exists(
  select 1 from public.workspace_members m where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid())
 )
);
-- No client insert/update/delete grants on the PDF bucket. Worker uses a server-only key.
