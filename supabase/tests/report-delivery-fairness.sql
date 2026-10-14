-- Run as the SQL editor's database role after prioritize_pending_report_pdfs.
-- No storage, AWS, or email calls. Fixtures and all claim-function updates roll
-- back. Workers cannot see the uncommitted fixtures. Ancient fixture timestamps
-- keep global claims on these fixtures without changing existing queue order.
begin;
do $$ begin
 if exists(select 1 from public.report_deliveries where created_at<'1002-01-01'::timestamptz) then
   raise exception 'Fixture dates would overlap existing deliveries; stop without claiming'; end if;
 if has_function_privilege('anon','public.claim_report_delivery(uuid)','execute')
   or has_function_privilege('authenticated','public.claim_report_delivery(uuid)','execute')
   or not has_function_privilege('service_role','public.claim_report_delivery(uuid)','execute') then
   raise exception 'FAIL: delivery claiming is not service-only'; end if;
end; $$;

insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('f0000000-0000-4000-8000-000000000031','pdf-fairness@example.invalid',now(),false);
set local role authenticated;
set local request.jwt.claim.sub='f0000000-0000-4000-8000-000000000031';
set local request.jwt.claims='{"sub":"f0000000-0000-4000-8000-000000000031","role":"authenticated"}';
select public.register_field_contact('Synthetic PDF Queue Tester','+13055550131');
insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
select id,'qa-delivery-fairness','coral-gables',now(),'{"status":"saved","photos":[]}'::jsonb
 from public.workspaces where slug='rockwood-development';

reset role;
select set_config('rockwood.test.workspace',
 (select id::text from public.workspaces where slug='rockwood-development'),true);
set local role service_role;
do $$
declare workspace uuid; email_job uuid; pending_job uuid; next_pending uuid;
 delayed_job uuid; active_job uuid; uncertain_job uuid; index integer;
 claimed public.report_deliveries; first_lease uuid;
begin
 workspace := current_setting('rockwood.test.workspace')::uuid;
 for index in 1..12 loop
   insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
     snapshot,project_name,is_sample_project,pdf_path,created_at)
   values(workspace,'qa-delivery-fairness','qa-fairness-email-'||index,1,'{}',
     'Synthetic PDF queue',true,workspace::text||'/qa-ready-'||index||'.pdf',
     '1000-01-01'::timestamptz+index*interval '1 minute') returning id into email_job;
 end loop;
 insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
   snapshot,project_name,is_sample_project,created_at)
 values(workspace,'qa-delivery-fairness','qa-fairness-pending',1,'{}',
   'Synthetic PDF queue',true,'1001-01-01') returning id into pending_job;
 insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
   snapshot,project_name,is_sample_project,created_at)
 values(workspace,'qa-delivery-fairness','qa-fairness-next',1,'{}',
   'Synthetic PDF queue',true,'1001-01-02') returning id into next_pending;
 insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
   snapshot,project_name,is_sample_project,created_at,next_attempt_at)
 values(workspace,'qa-delivery-fairness','qa-fairness-delayed',1,'{}',
   'Synthetic PDF queue',true,'0999-01-01',now()+interval '1 hour') returning id into delayed_job;
 insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
   snapshot,project_name,is_sample_project,created_at,status,lease_token,lease_until)
 values(workspace,'qa-delivery-fairness','qa-fairness-active',1,'{}',
   'Synthetic PDF queue',true,'0998-01-01','processing',gen_random_uuid(),now()+interval '10 minutes')
 returning id,lease_token into active_job,first_lease;
 insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
   snapshot,project_name,is_sample_project,created_at,send_started_at)
 values(workspace,'qa-delivery-fairness','qa-fairness-uncertain',1,'{}',
   'Synthetic PDF queue',true,'0997-01-01',now()-interval '24 hours') returning id into uncertain_job;

 select * into strict claimed from public.claim_report_delivery(null);
 if claimed.id<>pending_job or claimed.attempts<>1 or claimed.lease_token is null then
   raise exception 'FAIL: older email backlog took precedence over a pending PDF'; end if;
 if exists(select 1 from public.claim_report_delivery(pending_job)) then
   raise exception 'FAIL: pending PDF claimed twice while leased'; end if;
 if exists(select 1 from public.claim_report_delivery(delayed_job)) then
   raise exception 'FAIL: future retry was claimed'; end if;
 if exists(select 1 from public.claim_report_delivery(active_job)) then
   raise exception 'FAIL: active lease was stolen'; end if;
 select * into strict claimed from public.claim_report_delivery(email_job);
 if claimed.id<>email_job then raise exception 'FAIL: explicit job request changed target'; end if;
 select * into strict claimed from public.claim_report_delivery(null);
 if claimed.id<>next_pending then raise exception 'FAIL: next pending PDF was not selected'; end if;
 update public.report_deliveries set lease_until=now()-interval '1 second' where id=active_job;
 select * into strict claimed from public.claim_report_delivery(active_job);
 if claimed.id<>active_job or claimed.lease_token=first_lease then
   raise exception 'FAIL: expired lease was not replaced'; end if;
 if (select status from public.report_deliveries where id=uncertain_job)<>'needs_attention' then
   raise exception 'FAIL: uncertain old send was not quarantined'; end if;
 if (select count(*) from public.report_deliveries where walkthrough_id='qa-delivery-fairness'
     and report_id like 'qa-fairness-email-%' and attempts=0)<>11 then
   raise exception 'FAIL: unrelated email backlog was claimed'; end if;
end; $$;
reset role;
rollback;
select 'PASS: pending PDFs precede old email backlog; retry dates, exclusive/renewed leases, explicit targets, uncertain-send protection and service-only access remain intact. All changes rolled back; no AWS or email calls.' as result;
