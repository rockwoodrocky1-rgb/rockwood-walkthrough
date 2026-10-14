-- Durable processing uses the canonical saved visit, never a browser-supplied
-- snapshot or a stored browser JWT. AWS workers receive only the job UUID.
create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  walkthrough_id text not null,
  source_revision integer not null check (source_revision > 0),
  requested_by uuid not null references auth.users(id),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed','conflict','cancelled')),
  phase text not null default 'queued'
    check (phase in ('queued','transcribing','reporting','complete')),
  transcribe_generation integer not null default 0 check (transcribe_generation >= 0),
  transcribe_failed boolean not null default false,
  transcribe_job_name text,
  audio_key text,
  transcript jsonb,
  report jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  poll_count integer not null default 0 check (poll_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  next_attempt_at timestamptz not null default now(),
  deadline_at timestamptz not null default (now() + interval '60 minutes'),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(workspace_id, walkthrough_id, source_revision),
  foreign key(workspace_id,walkthrough_id)
    references public.walkthroughs(workspace_id,id)
);
create index processing_jobs_due on public.processing_jobs(next_attempt_at)
  where status in ('queued','processing');
alter table public.processing_jobs enable row level security;
revoke all on public.processing_jobs from public,anon,authenticated;
grant select(id,workspace_id,walkthrough_id,source_revision,status,phase,
  transcript,report,last_error,created_at,updated_at,completed_at)
  on public.processing_jobs to authenticated;
grant all on public.processing_jobs to service_role;
create policy member_processing_status on public.processing_jobs for select
  to authenticated using (
    exists(select 1 from public.workspace_members m
      where m.workspace_id=processing_jobs.workspace_id
      and m.user_id=(select auth.uid()))
  );

create function private.preserve_processing_snapshot() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.walkthrough_id is distinct from old.walkthrough_id
    or new.source_revision is distinct from old.source_revision
    or new.requested_by is distinct from old.requested_by
    or new.snapshot is distinct from old.snapshot
    or new.created_at is distinct from old.created_at then
    raise exception 'Processing input is immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.preserve_processing_snapshot() from public,anon,authenticated;
create trigger preserve_processing_snapshot before update on public.processing_jobs
  for each row execute function private.preserve_processing_snapshot();

create function public.enqueue_report_processing(
  workspace_id uuid, walkthrough_id text, retry_failed boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target_workspace uuid := workspace_id;
  target_visit text := walkthrough_id;
  current_user_id uuid := (select auth.uid());
  visit public.walkthroughs;
  membership_role text;
  existing public.processing_jobs;
  created_id uuid;
  retry_transcription boolean;
begin
  if current_user_id is null then raise exception 'A browser session is required'; end if;
  select * into visit from public.walkthroughs w
    where w.workspace_id=target_workspace and w.id=target_visit for update;
  if not found then raise exception 'This visit is not available for processing'; end if;
  select m.role into membership_role from public.workspace_members m
    where m.workspace_id=target_workspace and m.user_id=current_user_id;
  if membership_role is null or not (membership_role='owner' or
    (membership_role in ('editor','contributor') and visit.created_by=current_user_id)) then
    raise exception 'Only the visit author or company owner can process this visit';
  end if;
  if visit.archived_at is not null or coalesce(visit.payload->>'status','') not in ('saved','interrupted') then
    raise exception 'Save this visit before processing';
  end if;
  if coalesce(visit.payload->'audio'->>'path','')='' and
    coalesce(trim(visit.payload->'transcript'->>'text'),'')='' and
    coalesce(trim(visit.payload->>'notes'),'')='' and
    jsonb_array_length(coalesce(visit.payload->'photos','[]'::jsonb))=0 then
    raise exception 'Add a recording, notes, or photos before processing';
  end if;
  -- A retry of a lost enqueue response can arrive after completion has advanced
  -- the visit revision. Return that completed job until a human edits the visit.
  select * into existing from public.processing_jobs j
    where j.workspace_id=target_workspace and j.walkthrough_id=target_visit
    and j.status='completed' and j.source_revision+1=visit.revision
    and j.id::text=visit.payload->'report'->>'id';
  if found then return existing.id; end if;
  select * into existing from public.processing_jobs j
    where j.workspace_id=target_workspace and j.walkthrough_id=target_visit
    and j.source_revision=visit.revision for update;
  if found then
    -- Repeated taps and request retries neither charge another budget unit nor
    -- restart a provider job. Only an explicit retry can reopen a failed job.
    if retry_failed and existing.status='failed' then
      if not public.consume_field_ai_budget() then raise exception 'The daily processing limit has been reached'; end if;
      -- Only a confirmed terminal provider failure permits a new paid job.
      -- Polling/network outages must keep the existing provider identity.
      retry_transcription := existing.phase='transcribing'
        and existing.transcript is null and existing.transcribe_failed;
      update public.processing_jobs set status='queued',phase='queued',
        attempts=0,poll_count=0,failure_count=0,next_attempt_at=now(),
        deadline_at=now()+interval '60 minutes',lease_token=null,lease_until=null,
        last_error=null,completed_at=null,
        transcribe_generation=transcribe_generation + case when retry_transcription then 1 else 0 end,
        transcribe_job_name=case when retry_transcription then null else transcribe_job_name end,
        audio_key=case when retry_transcription then null else audio_key end,
        transcribe_failed=case when retry_transcription then false else transcribe_failed end
        where id=existing.id;
    end if;
    return existing.id;
  end if;
  if not public.consume_field_ai_budget() then raise exception 'The daily processing limit has been reached'; end if;
  insert into public.processing_jobs(workspace_id,walkthrough_id,source_revision,requested_by,snapshot)
    values(target_workspace,target_visit,visit.revision,current_user_id,to_jsonb(visit))
    returning id into created_id;
  return created_id;
end;
$$;
revoke all on function public.enqueue_report_processing(uuid,text,boolean) from public,anon;
grant execute on function public.enqueue_report_processing(uuid,text,boolean) to authenticated;

create function public.claim_report_processing(job_id uuid default null)
returns setof public.processing_jobs language plpgsql set search_path = '' as $$
declare selected_id uuid;
begin
  select j.id into selected_id from public.processing_jobs j
    where (job_id is null or j.id=job_id) and j.next_attempt_at<=now()
    and (j.status='queued' or (j.status='processing' and j.lease_until<now()))
    order by j.next_attempt_at,j.created_at for update skip locked limit 1;
  if selected_id is null then return; end if;
  return query update public.processing_jobs set status='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
    where id=selected_id returning *;
end;
$$;
revoke all on function public.claim_report_processing(uuid) from public,anon,authenticated;
grant execute on function public.claim_report_processing(uuid) to service_role;

-- The worker has no broad UPDATE grant on walkthroughs. This function commits
-- only generated transcript/report fields after checking a live exclusive lease
-- and the exact source revision. Existing ownership/media safeguards still run.
create function public.complete_report_processing(
  job_id uuid, worker_lease uuid, transcript_value jsonb, report_value jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  job public.processing_jobs;
  visit public.walkthroughs;
  final_report jsonb;
  final_payload jsonb;
begin
  -- Match enqueue's visit-then-job lock order to avoid concurrent enqueue/finalize deadlocks.
  select * into job from public.processing_jobs j where j.id=job_id;
  if not found then raise exception 'Processing job not found'; end if;
  select * into visit from public.walkthroughs w
    where w.workspace_id=job.workspace_id and w.id=job.walkthrough_id for update;
  select * into job from public.processing_jobs j where j.id=job_id for update;
  if job.status='completed' then return 'completed'; end if;
  if job.status<>'processing' or worker_lease is null or job.lease_token is null
    or job.lease_token is distinct from worker_lease
    or job.lease_until is null or job.lease_until<=now() then
    raise exception 'Processing lease expired or changed';
  end if;
  if report_value is null or jsonb_typeof(report_value)<>'object'
    or coalesce(trim(report_value->>'summary'),'')=''
    or jsonb_typeof(report_value->'observations') is distinct from 'array'
    or jsonb_typeof(report_value->'actionItems') is distinct from 'array'
    or jsonb_typeof(report_value->'captions') is distinct from 'array' then
    raise exception 'A validated English report is required';
  end if;
  if transcript_value is not null and (
    jsonb_typeof(transcript_value) is distinct from 'object'
    or jsonb_typeof(transcript_value->'text') is distinct from 'string'
    or jsonb_typeof(transcript_value->'segments') is distinct from 'array'
    or coalesce(transcript_value->>'source','') not in ('audio','manual')) then
    raise exception 'A validated source transcript is required';
  end if;
  final_report := report_value || jsonb_build_object(
    'id',job.id::text,'projectId',visit.project_id,'sessionId',visit.id,
    'generatedAt',now(),'mode','live','outputLanguage','en','reviewStatus','draft');
  if visit.archived_at is not null then
    update public.processing_jobs set status='cancelled',transcript=transcript_value,
      report=final_report,last_error='This visit was archived. Generated work is retained.',
      lease_token=null,lease_until=null,completed_at=now() where id=job.id;
    return 'cancelled';
  end if;
  if visit.revision<>job.source_revision then
    update public.processing_jobs set status='conflict',transcript=transcript_value,
      report=final_report,last_error='This visit changed during processing. Generated work is retained for review.',
      lease_token=null,lease_until=null,completed_at=now() where id=job.id;
    return 'conflict';
  end if;
  final_payload := (visit.payload-'error') || jsonb_build_object('report',final_report);
  if transcript_value is not null then
    final_payload := final_payload || jsonb_build_object('transcript',transcript_value);
  end if;
  update public.walkthroughs set payload=final_payload,revision=revision+1
    where workspace_id=job.workspace_id and id=job.walkthrough_id;
  update public.processing_jobs set status='completed',phase='complete',
    transcript=transcript_value,report=final_report,last_error=null,
    lease_token=null,lease_until=null,completed_at=now() where id=job.id;
  return 'completed';
end;
$$;
revoke all on function public.complete_report_processing(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_report_processing(uuid,uuid,jsonb,jsonb) to service_role;
