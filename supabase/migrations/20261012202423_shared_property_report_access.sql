-- Owner-approved internal workflow: everyone who enters name + phone can read
-- all property visits in the Rockwood workspace. No verified identity is implied.
-- Keep existing ownership rules for writes and keep both Storage buckets private.
alter policy member_walkthroughs on public.walkthroughs using (
  exists(select 1 from public.workspace_members m
    where m.workspace_id=walkthroughs.workspace_id and m.user_id=(select auth.uid()))
);
alter policy member_media_read on storage.objects using (
  bucket_id='walkthrough-media' and exists(select 1 from public.workspace_members m
    where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid()))
);
alter policy member_delivery_status on public.report_deliveries using (
  exists(select 1 from public.workspace_members m
    where m.workspace_id=report_deliveries.workspace_id and m.user_id=(select auth.uid()))
);
alter policy member_report_pdf on storage.objects using (
  bucket_id='walkthrough-reports' and exists(select 1 from public.workspace_members m
    where m.workspace_id::text=(storage.foldername(name))[1] and m.user_id=(select auth.uid()))
);
