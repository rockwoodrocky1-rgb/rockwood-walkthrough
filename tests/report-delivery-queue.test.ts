import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

const db = new PGlite();
const author = "81111111-1111-4111-8111-111111111111";
let workspace: string;
let sequence = 0;

async function delivery(pdfReady = false, ageMinutes = 0) {
  const reportId = `queue-report-${++sequence}`;
  return (await db.query<{ id: string }>(`
    insert into public.report_deliveries(workspace_id,walkthrough_id,report_id,revision,
      snapshot,project_name,is_sample_project,pdf_path,created_at)
    values($1,'queue-fixture',$2,1,'{}','Queue fixture',true,$3,
      now()-($4::integer * interval '1 minute')) returning id`,
  [workspace, reportId, pdfReady ? `${workspace}/${reportId}.pdf` : null, ageMinutes])).rows[0].id;
}

async function claim(jobId: string | null = null) {
  return (await db.query<{ id: string; lease_token: string; attempts: number }>(
    "select * from public.claim_report_delivery($1)", [jobId],
  )).rows;
}

beforeAll(async () => {
  // Run the real migrations/policies against local PostgreSQL, with no live calls.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;`);
  for (const file of (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort())
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  workspace = (await db.query<{ id: string }>("select id from public.workspaces")).rows[0].id;
  await db.query("insert into auth.users values($1,null,null,true)", [author]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [author]);
  await db.exec("set role authenticated; select public.register_field_contact('Queue Tester','+13055550131');");
  await db.query(`insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
    values($1,'queue-fixture','coral-gables',now(),'{"status":"saved","photos":[]}')`, [workspace]);
  await db.exec("reset role;");
}, 30000);

beforeEach(() => db.exec("begin; set local role service_role;"));
afterEach(() => db.exec("rollback; reset role;"));
afterAll(() => db.close());

describe("Private PDF queue fairness against local PostgreSQL", () => {
  it("renders pending PDFs before an older email backlog, then resumes that backlog", async () => {
    const oldEmails = [];
    for (let i = 0; i < 12; i++) oldEmails.push(await delivery(true, 120 - i));
    const olderPending = await delivery(false, 2);
    const newerPending = await delivery(false, 1);
    expect((await claim())[0].id).toBe(olderPending);
    expect((await claim())[0].id).toBe(newerPending);
    expect((await claim())[0].id).toBe(oldEmails[0]);
    expect((await db.query<{ attempts: number }>(
      "select attempts from public.report_deliveries where id=$1", [oldEmails[1]],
    )).rows[0].attempts).toBe(0);
  });

  it("does not bypass retry delays or active leases to prioritize PDFs", async () => {
    const delayed = await delivery(false, 20);
    await db.query("update public.report_deliveries set next_attempt_at=now()+interval '1 hour' where id=$1", [delayed]);
    const active = await delivery(false, 10);
    const firstLease = (await claim(active))[0];
    const email = await delivery(true, 5);
    expect((await claim())[0].id).toBe(email);
    expect(await claim(delayed)).toEqual([]);
    expect(await claim(active)).toEqual([]);
    await db.query("update public.report_deliveries set lease_until=now()-interval '1 second' where id=$1", [active]);
    const renewed = (await claim())[0];
    expect(renewed.id).toBe(active);
    expect(renewed.lease_token).not.toBe(firstLease.lease_token);
    expect(renewed.attempts).toBe(2);
  });

  it("honors an explicit job request without claiming another higher-priority PDF", async () => {
    const email = await delivery(true, 30);
    const pending = await delivery(false);
    expect((await claim(email))[0].id).toBe(email);
    expect(await claim(email)).toEqual([]);
    expect((await claim())[0].id).toBe(pending);
  });

  it("continues quarantining uncertain old sends and keeps worker claiming private", async () => {
    const uncertain = await delivery(false, 60);
    await db.query("update public.report_deliveries set send_started_at=now()-interval '24 hours' where id=$1", [uncertain]);
    const pending = await delivery(false);
    expect((await claim())[0].id).toBe(pending);
    expect((await db.query<{ status: string }>(
      "select status from public.report_deliveries where id=$1", [uncertain],
    )).rows[0].status).toBe("needs_attention");
    expect(await claim(uncertain)).toEqual([]);
    await db.exec("reset role;");
    const permissions = (await db.query<{ anonymous: boolean; browser: boolean; worker: boolean }>(`
      select has_function_privilege('anon','public.claim_report_delivery(uuid)','execute') as anonymous,
        has_function_privilege('authenticated','public.claim_report_delivery(uuid)','execute') as browser,
        has_function_privilege('service_role','public.claim_report_delivery(uuid)','execute') as worker`)).rows[0];
    expect(permissions).toEqual({ anonymous: false, browser: false, worker: true });
  });

  it("passes the transactional live-proof script and rolls back every fixture", async () => {
    await db.exec("rollback; reset role;");
    await db.exec(await readFile("supabase/tests/report-delivery-fairness.sql", "utf8"));
    expect((await db.query("select id from auth.users where id='f0000000-0000-4000-8000-000000000031'")).rows).toEqual([]);
    expect((await db.query("select id from public.report_deliveries where walkthrough_id='qa-delivery-fairness'")).rows).toEqual([]);
  });
});
