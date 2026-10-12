-- The project's explicit API grants also restrict service_role. The worker only
-- needs to check whether a queued visit was archived before sending it.
grant select (workspace_id, id, archived_at) on public.walkthroughs to service_role;
