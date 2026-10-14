-- Run as the SQL editor's database role after the durable-processing migration.
-- Synthetic users/visits/jobs/quota increments exist only in this transaction.
-- No storage upload, AWS call, or email is performed. Workers cannot see these
-- uncommitted jobs. Every test record and queued delivery rolls back below.
begin;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('f0000000-0000-4000-8000-000000000021','processing-author@example.invalid',now(),false),
 ('f0000000-0000-4000-8000-000000000022','processing-coworker@example.invalid',now(),false),
 ('f0000000-0000-4000-8000-000000000023','processing-outsider@example.invalid',now(),false);

set local role authenticated;
set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000021';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000021","role":"authenticated"}';
select public.register_field_contact('Synthetic Processing Author','+13055550121');
insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
select id,'qa-processing-transaction','coral-gables',now(),
 '{"status":"saved","duration":0,"language":"es","recordingLanguage":"en","notes":"Synthetic source note.","mime":"","photos":[]}'::jsonb
 from public.workspaces where slug='rockwood-development';
do $$
declare workspace uuid; job uuid;
begin
 select id into strict workspace from public.workspaces where slug='rockwood-development';
 job := public.enqueue_report_processing(workspace,'qa-processing-transaction',false);
 if public.enqueue_report_processing(workspace,'qa-processing-transaction',false)<>job then
   raise exception 'FAIL: repeated enqueue created another job'; end if;
 begin
   perform snapshot from public.processing_jobs where id=job;
   raise exception 'FAIL: browser can read internal processing snapshot';
 exception when insufficient_privilege then null; end;
 begin
   update public.processing_jobs set status='completed' where id=job;
   raise exception 'FAIL: browser can forge completion';
 exception when insufficient_privilege then null; end;
 begin
   perform public.claim_report_processing(job);
   raise exception 'FAIL: browser can claim worker jobs';
 exception when insufficient_privilege then null; end;
 begin
   perform public.complete_report_processing(job,null,null,'{}'::jsonb);
   raise exception 'FAIL: browser can finalize worker jobs';
 exception when insufficient_privilege then null; end;
end; $$;

set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000022';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000022","role":"authenticated"}';
select public.register_field_contact('Synthetic Processing Coworker','+13055550122');
do $$
declare workspace uuid;
begin
 select id into strict workspace from public.workspaces where slug='rockwood-development';
 if (select count(id) from public.processing_jobs where walkthrough_id='qa-processing-transaction')<>1 then
   raise exception 'FAIL: company member cannot read shared processing status'; end if;
 begin
   perform public.enqueue_report_processing(workspace,'qa-processing-transaction',false);
   raise exception 'FAIL: coworker can process another author''s visit';
 exception when raise_exception then
   if SQLERRM<>'Only the visit author or company owner can process this visit' then raise; end if;
 end;
end; $$;

set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000023';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000023","role":"authenticated"}';
do $$ begin
 if exists(select id from public.processing_jobs where walkthrough_id='qa-processing-transaction') then
   raise exception 'FAIL: outsider can read processing status'; end if;
end; $$;

reset role;
do $$ begin
 if (select count(*) from public.processing_jobs where walkthrough_id='qa-processing-transaction')<>1 then
   raise exception 'FAIL: duplicate processing jobs'; end if;
 if (select calls from private.ai_daily_usage where usage_date=current_date
     and subject='f0000000-0000-4000-8000-000000000021')<>1 then
   raise exception 'FAIL: repeated enqueue consumed quota again'; end if;
 if has_function_privilege('anon','public.enqueue_report_processing(uuid,text,boolean)','execute')
   or has_function_privilege('anon','public.claim_report_processing(uuid)','execute')
   or has_function_privilege('authenticated','public.complete_report_processing(uuid,uuid,jsonb,jsonb)','execute') then
   raise exception 'FAIL: public worker access'; end if;
 if not (select rowsecurity from pg_tables where schemaname='public' and tablename='processing_jobs') then
   raise exception 'FAIL: processing row security disabled'; end if;
end; $$;

set local role service_role;
do $$
declare job uuid; first_claim public.processing_jobs; next_claim public.processing_jobs;
  transcript jsonb := '{"source":"manual","text":"Synthetic source note.","segments":[]}';
  report jsonb := '{"summary":"Synthetic English report.","observations":[],"actionItems":[],"captions":[]}';
begin
 select id into strict job from public.processing_jobs where walkthrough_id='qa-processing-transaction';
 select * into strict first_claim from public.claim_report_processing(job);
 if exists(select 1 from public.claim_report_processing(job)) then
   raise exception 'FAIL: active job leased twice'; end if;
 begin
   update public.processing_jobs set snapshot='{}'::jsonb where id=job;
   raise exception 'FAIL: immutable source snapshot changed';
 exception when raise_exception then
   if SQLERRM<>'Processing input is immutable' then raise; end if;
 end;
 update public.processing_jobs set lease_until=now()-interval '1 minute' where id=job;
 begin
   perform public.complete_report_processing(job,first_claim.lease_token,transcript,report);
   raise exception 'FAIL: expired worker completed report';
 exception when raise_exception then
   if SQLERRM<>'Processing lease expired or changed' then raise; end if;
 end;
 select * into strict next_claim from public.claim_report_processing(job);
 if first_claim.lease_token=next_claim.lease_token then raise exception 'FAIL: lease token reused'; end if;
 begin
   perform public.complete_report_processing(job,first_claim.lease_token,transcript,report);
   raise exception 'FAIL: stale worker completed report';
 exception when raise_exception then
   if SQLERRM<>'Processing lease expired or changed' then raise; end if;
 end;
 if public.complete_report_processing(job,next_claim.lease_token,transcript,report)<>'completed'
   or public.complete_report_processing(job,next_claim.lease_token,transcript,report)<>'completed' then
   raise exception 'FAIL: completion was not idempotent'; end if;
 if (select revision from public.walkthroughs where id='qa-processing-transaction')<>2 then
   raise exception 'FAIL: completion advanced revision more than once'; end if;
 if (select created_by from public.walkthroughs where id='qa-processing-transaction')<>'f0000000-0000-4000-8000-000000000021'::uuid
   or (select payload->>'recordingLanguage' from public.walkthroughs where id='qa-processing-transaction')<>'en'
   or (select payload->>'notes' from public.walkthroughs where id='qa-processing-transaction')<>'Synthetic source note.' then
   raise exception 'FAIL: source evidence or ownership replaced'; end if;
 if (select payload->'report'->>'outputLanguage' from public.walkthroughs where id='qa-processing-transaction')<>'en'
   or (select count(*) from public.report_deliveries where walkthrough_id='qa-processing-transaction')<>1 then
   raise exception 'FAIL: English result or atomic single delivery missing'; end if;
end; $$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000022';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000022","role":"authenticated"}';
do $$ begin
 if (select transcript->>'text' from public.processing_jobs where walkthrough_id='qa-processing-transaction')<>'Synthetic source note.' then
   raise exception 'FAIL: company member cannot read recovered transcript'; end if;
end; $$;
reset role;
rollback;
select 'PASS: author-only enqueue, shared safe status, outsider isolation, one quota unit, immutable snapshot, exclusive/expiring leases, idempotent English completion, preserved evidence and atomic PDF outbox. All synthetic data rolled back; no AWS calls or email.' as result;
