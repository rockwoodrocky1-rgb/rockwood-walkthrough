-- The dashboard's automatic-RLS event trigger must not be a public RPC.
-- The database owner retains execute privilege for its DDL event trigger.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
