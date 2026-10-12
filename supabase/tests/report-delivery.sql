-- All users, jobs and visits roll back; no email is sent by this test.
begin;
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('f0000000-0000-4000-8000-000000000011','delivery-test@example.invalid',now(),false),
('f0000000-0000-4000-8000-000000000012','delivery-outsider@example.invalid',now(),false);
insert into public.workspace_members(workspace_id,user_id,role)
select id,'f0000000-0000-4000-8000-000000000011','owner' from public.workspaces where slug='rockwood-development';
set local role authenticated;
set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000011';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
select id,'delivery-test','coral-gables',now(),'{"report":{"id":"delivery-report-test","mode":"manual","summary":"first"}}' from public.workspaces where slug='rockwood-development';
update public.walkthroughs set revision=revision+1,payload='{"report":{"id":"delivery-report-test","mode":"manual","summary":"edited"}}' where id='delivery-test';
do $$ begin
 if (select count(id) from public.report_deliveries where report_id='delivery-report-test')<>1 then raise exception 'FAIL: missing/duplicate delivery'; end if;
 begin
  update public.report_deliveries set status='sent' where report_id='delivery-report-test';
  raise exception 'FAIL: browser can forge sent status';
 exception when insufficient_privilege then null; end;
 begin
  perform public.claim_report_delivery(null);
  raise exception 'FAIL: browser can run worker';
 exception when insufficient_privilege then null; end;
 begin
  perform snapshot from public.report_deliveries;
  raise exception 'FAIL: internal snapshot exposed';
 exception when insufficient_privilege then null; end;
end; $$;
insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
select id,'delivery-sample-test','coral-gables',now(),'{"report":{"id":"delivery-sample-report-test","mode":"sample"}}' from public.workspaces where slug='rockwood-development';
set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000012';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000012","role":"authenticated"}';
do $$ begin
 if exists(select id from public.report_deliveries) then raise exception 'FAIL: outsider sees delivery records'; end if;
end; $$;
reset role;
do $$ declare job uuid; n integer; begin
 select id into job from public.report_deliveries where report_id='delivery-report-test';
 if (select snapshot->'payload'->'report'->>'summary' from public.report_deliveries where id=job)<>'first' then raise exception 'FAIL: snapshot changed after editing'; end if;
 if exists(select 1 from public.report_deliveries where report_id='delivery-sample-report-test') then raise exception 'FAIL: sample report queued'; end if;
 select count(*) into n from public.claim_report_delivery(job);
 if n<>1 then raise exception 'FAIL: worker cannot claim'; end if;
 select count(*) into n from public.claim_report_delivery(job);
 if n<>0 then raise exception 'FAIL: duplicate lease'; end if;
 update public.report_deliveries set lease_until=now()-interval '1 minute' where id=job;
 select count(*) into n from public.claim_report_delivery(job);
 if n<>1 then raise exception 'FAIL: expired lease not recovered'; end if;
 update public.report_deliveries set lease_until=now()-interval '1 minute',send_started_at=now()-interval '25 hours' where id=job;
 select count(*) into n from public.claim_report_delivery(job);
 if n<>0 or (select status from public.report_deliveries where id=job)<>'needs_attention' then raise exception 'FAIL: uncertain old send replayed'; end if;
 if (select public from storage.buckets where id='walkthrough-reports') then raise exception 'FAIL: public PDF bucket'; end if;
 if has_function_privilege('anon','public.claim_report_delivery(uuid)','execute') then raise exception 'FAIL: anonymous worker access'; end if;
end; $$;
rollback;
begin;
set local role service_role;
select workspace_id,id,archived_at from public.walkthroughs limit 0;
rollback;
select 'PASS: atomic queue, immutable snapshot, no duplicate job, exclusive lease, expiry recovery, uncertain-send stop, member-only status and private PDF storage. Tests rolled back.' as result;
