import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

const db = new PGlite();
const author = "71111111-1111-4111-8111-111111111111";
const coworker = "72222222-2222-4222-8222-222222222222";
const owner = "73333333-3333-4333-8333-333333333333";
const outsider = "74444444-4444-4444-8444-444444444444";
let workspace: string;
let sequence = 0;
const sourceTranscript = {
  source: "audio",
  text: "Falta pintar la pared.",
  segments: [{ id: "segment-0", start: 0, end: 2, text: "Falta pintar la pared." }],
};
const report = {
  summary: "The wall still needs painting.",
  observations: [], actionItems: [], captions: [],
};
async function role(name: "authenticated" | "service_role" | "anon", user = "") {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec(`set role ${name};`);
}
async function visit() {
  const id = `processing-${++sequence}`;
  await role("authenticated", author);
  await db.query(`insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload)
    values($1,$2,'coral-gables',now(),$3)`, [workspace, id, JSON.stringify({
    status: "saved", language: "es", duration: 3, notes: "Pared", mime: "audio/mp4", photos: [],
    audio: { path: `${workspace}/${author}/${id}/original-audio`, type: "audio/mp4", size: 1000 },
  })]);
  return id;
}
async function enqueue(id: string, user = author, retry = false) {
  await role("authenticated", user);
  return (await db.query<{ id: string }>(
    "select public.enqueue_report_processing($1,$2,$3) as id", [workspace, id, retry],
  )).rows[0].id;
}
async function claim(id: string) {
  await role("service_role");
  return (await db.query<{ id: string; lease_token: string; snapshot: { payload: { notes: string } } }>(
    "select * from public.claim_report_processing($1)", [id],
  )).rows;
}
async function finish(id: string, lease: string) {
  await role("service_role");
  return (await db.query<{ status: string }>(
    "select public.complete_report_processing($1,$2,$3,$4) as status",
    [id, lease, JSON.stringify(sourceTranscript), JSON.stringify(report)],
  )).rows[0].status;
}

beforeAll(async () => {
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
  await db.query(`insert into auth.users values($1,null,null,true),($2,null,null,true),
    ($3,'rockwoodrocky1@gmail.com',now(),false),($4,null,null,true)`, [author, coworker, owner, outsider]);
  await role("authenticated", author);
  await db.exec("select public.register_field_contact('Ana Garcia','+13055550123')");
  await role("authenticated", coworker);
  await db.exec("select public.register_field_contact('Mateo Test','+13055550124')");
  await role("authenticated", owner);
  await db.exec("select public.claim_workspace_access()");
}, 30000);
afterAll(() => db.close());

describe("Durable report processing against local PostgreSQL", () => {
  it("only enqueues saved canonical evidence for its author or company owner", async () => {
    const id = await visit();
    await expect(enqueue(id, coworker)).rejects.toThrow("author or company owner");
    await expect(enqueue(id, outsider)).rejects.toThrow("author or company owner");
    const job = await enqueue(id, owner);
    const rows = await claim(job);
    expect(rows[0].snapshot.payload.notes).toBe("Pared");
    await role("anon");
    await expect(db.query("select public.enqueue_report_processing($1,$2,false)", [workspace,id])).rejects.toThrow();
  });
  it("returns the same job for repeated taps without repeatedly spending quota", async () => {
    const id = await visit();
    const job = await enqueue(id);
    await db.exec("reset role;");
    const before = (await db.query<{ calls: number }>("select calls from private.ai_daily_usage where subject=$1", [author])).rows[0].calls;
    for (let i = 0; i < 3; i++) expect(await enqueue(id)).toBe(job);
    await db.exec("reset role;");
    expect((await db.query<{ calls: number }>("select calls from private.ai_daily_usage where subject=$1", [author])).rows[0].calls).toBe(before);
  });
  it("exposes status and recovered results to members, never snapshots or worker privileges", async () => {
    const job = await enqueue(await visit());
    const lease = (await claim(job))[0].lease_token;
    await db.query("update public.processing_jobs set transcript=$1 where id=$2 and lease_token=$3", [JSON.stringify(sourceTranscript),job,lease]);
    await role("authenticated", coworker);
    expect((await db.query<{ transcript: unknown }>("select transcript from public.processing_jobs where id=$1", [job])).rows[0].transcript).toEqual(sourceTranscript);
    await expect(db.query("select snapshot from public.processing_jobs where id=$1", [job])).rejects.toThrow();
    await expect(db.query("update public.processing_jobs set status='completed' where id=$1", [job])).rejects.toThrow();
    await expect(db.query("select * from public.claim_report_processing($1)", [job])).rejects.toThrow();
    await expect(db.query("select public.complete_report_processing($1,$2,null,$3)", [job,lease,JSON.stringify(report)])).rejects.toThrow();
    await role("authenticated", outsider);
    expect((await db.query("select id from public.processing_jobs where id=$1", [job])).rows).toEqual([]);
  });
  it("leases work exclusively and rejects stale workers after lease renewal", async () => {
    const job = await enqueue(await visit());
    const first = (await claim(job))[0];
    expect(await claim(job)).toEqual([]);
    await expect(db.query("select public.complete_report_processing($1,null,$2,$3)", [job,JSON.stringify(sourceTranscript),JSON.stringify(report)])).rejects.toThrow("lease expired");
    await db.query("update public.processing_jobs set lease_until=now()-interval '1 second' where id=$1", [job]);
    await expect(finish(job, first.lease_token)).rejects.toThrow("lease expired");
    const second = (await claim(job))[0];
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(finish(job, first.lease_token)).rejects.toThrow("lease expired");
    await expect(db.query("update public.processing_jobs set snapshot='{}' where id=$1", [job])).rejects.toThrow("immutable");
  });
  it("commits English output once, preserves original evidence, and queues one delivery", async () => {
    const id = await visit();
    const job = await enqueue(id);
    const lease = (await claim(job))[0].lease_token;
    expect(await finish(job, lease)).toBe("completed");
    expect(await finish(job, lease)).toBe("completed");
    const saved = (await db.query<{ revision: number; created_by: string; payload: Record<string, unknown> }>("select revision,created_by,payload from public.walkthroughs where id=$1", [id])).rows[0];
    expect(saved.revision).toBe(2);
    expect(saved.created_by).toBe(author);
    expect(saved.payload).toMatchObject({
      notes: "Pared", language: "es", transcript: sourceTranscript,
      audio: { path: `${workspace}/${author}/${id}/original-audio` },
      report: { id: job, mode: "live", outputLanguage: "en", summary: report.summary },
    });
    expect((await db.query("select id from public.report_deliveries where walkthrough_id=$1", [id])).rows).toHaveLength(1);
    // A lost initial response retried after successful completion must not enqueue another charged job.
    expect(await enqueue(id)).toBe(job);
  });
  it("retains generated results without overwriting source edits or archiving", async () => {
    const id = await visit();
    const job = await enqueue(id);
    const lease = (await claim(job))[0].lease_token;
    await role("authenticated", author);
    await db.query("update public.walkthroughs set payload=jsonb_set(payload,'{notes}','\"Human correction\"'),revision=revision+1 where id=$1", [id]);
    expect(await finish(job, lease)).toBe("conflict");
    expect((await db.query<{ payload: { notes: string; report?: unknown } }>("select payload from public.walkthroughs where id=$1", [id])).rows[0].payload).toMatchObject({ notes: "Human correction" });
    expect((await db.query<{ report: unknown }>("select report from public.processing_jobs where id=$1", [job])).rows[0].report).toMatchObject(report);
    expect((await db.query("select id from public.report_deliveries where walkthrough_id=$1", [id])).rows).toEqual([]);
    const archived = await visit();
    const archivedJob = await enqueue(archived);
    const archivedLease = (await claim(archivedJob))[0].lease_token;
    await role("authenticated", author);
    await db.query("update public.walkthroughs set archived_at=now(),revision=revision+1 where id=$1", [archived]);
    expect(await finish(archivedJob, archivedLease)).toBe("cancelled");
  });
  it("keeps transcription checkpoints and provider job identity during explicit failed retries", async () => {
    const id = await visit();
    const job = await enqueue(id);
    await role("service_role");
    await db.query("update public.processing_jobs set status='failed',phase='reporting',transcribe_job_name='existing-job',transcript=$1,last_error='Provider unavailable' where id=$2", [JSON.stringify(sourceTranscript),job]);
    expect(await enqueue(id)).toBe(job);
    await role("service_role");
    expect((await db.query<{ status: string }>("select status from public.processing_jobs where id=$1", [job])).rows[0].status).toBe("failed");
    expect(await enqueue(id, author, true)).toBe(job);
    await role("service_role");
    expect((await db.query("select status,phase,transcribe_generation,transcribe_job_name,transcript from public.processing_jobs where id=$1", [job])).rows[0]).toMatchObject({ status: "queued", phase: "queued", transcribe_generation: 0, transcribe_job_name: "existing-job", transcript: sourceTranscript });
  });
  it("starts a new provider generation only for an explicit retry of a confirmed terminal transcription failure", async () => {
    const id = await visit();
    const job = await enqueue(id);
    await role("service_role");
    await db.query("update public.processing_jobs set status='failed',phase='transcribing',transcribe_job_name='existing-job',audio_key='existing-audio' where id=$1", [job]);
    // A polling outage may leave AWS running: keep that paid job on retry.
    await enqueue(id, author, true);
    await role("service_role");
    expect((await db.query("select transcribe_generation,transcribe_job_name from public.processing_jobs where id=$1", [job])).rows[0]).toEqual({ transcribe_generation: 0, transcribe_job_name: "existing-job" });
    await db.query("update public.processing_jobs set status='failed',phase='transcribing',transcribe_failed=true where id=$1", [job]);
    await enqueue(id);
    await role("service_role");
    expect((await db.query("select transcribe_generation,transcribe_job_name from public.processing_jobs where id=$1", [job])).rows[0]).toEqual({ transcribe_generation: 0, transcribe_job_name: "existing-job" });
    await enqueue(id, author, true);
    await role("service_role");
    expect((await db.query("select status,transcribe_generation,transcribe_job_name,audio_key,transcribe_failed from public.processing_jobs where id=$1", [job])).rows[0]).toEqual({ status: "queued", transcribe_generation: 1, transcribe_job_name: null, audio_key: null, transcribe_failed: false });
  });
});
