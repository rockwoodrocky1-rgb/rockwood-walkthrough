-- Make new PDFs available before retrying older, already-rendered email jobs.
-- Eligibility, expired-send protection and exclusive leases remain unchanged.
create or replace function public.claim_report_delivery(job_id uuid default null)
returns setof public.report_deliveries language plpgsql set search_path = '' as $$
declare selected_id uuid;
begin
 update public.report_deliveries set status='needs_attention',last_error='Email confirmation needs an administrator review. Automatic resending is paused.'
 where status in ('queued','processing') and send_started_at < now()-interval '23 hours'
 and (lease_until is null or lease_until < now());
 select d.id into selected_id from public.report_deliveries d
 where (job_id is null or d.id=job_id) and d.next_attempt_at<=now()
 and (d.status='queued' or (d.status='processing' and d.lease_until<now()))
 order by (d.pdf_path is null) desc,d.created_at,d.id for update skip locked limit 1;
 if selected_id is null then return; end if;
 return query update public.report_deliveries set status='processing',attempts=attempts+1,
   lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes'
 where id=selected_id returning *;
end;
$$;
revoke all on function public.claim_report_delivery(uuid) from public,anon,authenticated;
grant execute on function public.claim_report_delivery(uuid) to service_role;
