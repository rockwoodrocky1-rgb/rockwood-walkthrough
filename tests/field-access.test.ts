import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

const db = new PGlite();
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const outsider = "44444444-4444-4444-8444-444444444444";
let workspace: string;
async function asUser(id: string, sql: string) {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${id}', false); set role authenticated;`,
  );
  return db.exec(sql);
}
beforeAll(async () => {
  // Real PostgreSQL policies/functions execute locally. Minimal Supabase platform
  // tables stand in for Auth/Storage; there are no network calls or live mutations.
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
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  }
  workspace = (
    await db.query<{ id: string }>("select id from public.workspaces")
  ).rows[0].id;
  await db.exec(
    `insert into auth.users values('${userA}',null,null,true),('${userB}',null,null,true),('${outsider}',null,null,true),('${owner}','rockwoodrocky1@gmail.com',now(),false);`,
  );
  await asUser(
    userA,
    "select public.register_field_contact('Ana García','+13055550123');",
  );
  // Same name and phone still creates an independent identity, never a lookup match.
  await asUser(
    userB,
    "select public.register_field_contact('Ana García','+13055550123');",
  );
  await asUser(owner, "select public.claim_workspace_access();");
}, 30000);
afterAll(async () => {
  await db.close();
});
describe("Name/phone field access against local PostgreSQL", () => {
  it("grants contributor only, with no phone-based account merging or member editing", async () => {
    const result = await asUser(
      userA,
      "select role,user_id from public.workspace_members;",
    );
    expect(result[0].rows).toEqual([{ role: "contributor", user_id: userA }]);
    await expect(
      asUser(userA, "update public.workspace_members set role='owner';"),
    ).rejects.toThrow();
    await expect(
      asUser(userA, "select public.register_field_contact('A','not-a-phone');"),
    ).rejects.toThrow();
  });
  it("shares property visits with entered users while preventing changes to another person's visit", async () => {
    await asUser(
      userA,
      `insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload) values('${workspace}','visit-a','coral-gables',now(),'${JSON.stringify({ notes: "Pendiente", photos: [], participant: { name: "Forged", phone: "99999999" } })}');`,
    );
    const own = await asUser(
      userA,
      "select payload->'participant' as contact from public.walkthroughs where id='visit-a';",
    );
    expect(own[0].rows).toEqual([
      { contact: { name: "Ana García", phone: "+13055550123" } },
    ]);
    expect(
      (
        await asUser(
          userB,
          "select id from public.walkthroughs where id='visit-a';",
        )
      )[0].rows,
    ).toEqual([{ id: "visit-a" }]);
    expect(
      (
        await asUser(
          userB,
          "update public.walkthroughs set revision=revision+1 where id='visit-a' returning id;",
        )
      )[0].rows,
    ).toEqual([]);
    expect(
      (
        await asUser(
          owner,
          "select id from public.walkthroughs where id='visit-a';",
        )
      )[0].rows,
    ).toHaveLength(1);
  });
  it("keeps contacts private and prevents calling registration without a session", async () => {
    expect(
      (
        await asUser(
          userB,
          `select * from public.field_contacts where user_id='${userA}';`,
        )
      )[0].rows,
    ).toEqual([]);
    await db.exec("reset role; set role anon;");
    await expect(
      db.exec("select public.register_field_contact('Visitor','3055550123');"),
    ).rejects.toThrow();
  });
  it("shares property photos for reading and rejects forged worker evidence paths", async () => {
    const ownPath = `${workspace}/${userA}/visit-a/abc`;
    await asUser(
      userA,
      `insert into storage.objects(bucket_id,name) values('walkthrough-media','${ownPath}');`,
    );
    expect(
      (await asUser(userB, "select name from storage.objects;"))[0].rows,
    ).toEqual([{ name: ownPath }]);
    expect((await asUser(userB, `update storage.objects set name='changed' where name='${ownPath}' returning name;`))[0].rows).toEqual([]);
    const payload = {
      photos: [{ original: { path: ownPath }, model: { path: ownPath } }],
    };
    await expect(
      asUser(
        userB,
        `insert into public.walkthroughs(workspace_id,id,project_id,started_at,payload) values('${workspace}','forged','coral-gables',now(),'${JSON.stringify(payload)}');`,
      ),
    ).rejects.toThrow("Invalid photo path");
  });
  it("holds Spanish reports until English is ready, shares PDFs and keeps one outbox job", async () => {
    const payload = {
      photos: [],
      language: "es",
      report: { id: "report-a", mode: "manual", summary: "Pendiente" },
    };
    await expect(
      asUser(
        userA,
        `update public.walkthroughs set payload='${JSON.stringify(payload)}',revision=revision+1 where id='visit-a';`,
      ),
    ).rejects.toThrow("English report");
    const english = {
      ...payload,
      report: { ...payload.report, summary: "Pending", outputLanguage: "en" },
    };
    await asUser(
      userA,
      `update public.walkthroughs set payload='${JSON.stringify(english)}',revision=revision+1 where id='visit-a';`,
    );
    await asUser(
      userA,
      "update public.walkthroughs set revision=revision+1 where id='visit-a';",
    );
    expect(
      (await asUser(userA, "select id from public.report_deliveries;"))[0].rows,
    ).toHaveLength(1);
    expect(
      (await asUser(userB, "select id from public.report_deliveries;"))[0].rows,
    ).toHaveLength(1);
    await db.exec(
      `reset role; update public.report_deliveries set pdf_path='${workspace}/report-a.pdf'; insert into storage.objects(bucket_id,name) values('walkthrough-reports','${workspace}/report-a.pdf');`,
    );
    expect(
      (
        await asUser(
          userA,
          "select name from storage.objects where bucket_id='walkthrough-reports';",
        )
      )[0].rows,
    ).toHaveLength(1);
    expect(
      (
        await asUser(
          userB,
          "select name from storage.objects where bucket_id='walkthrough-reports';",
        )
      )[0].rows,
    ).toHaveLength(1);
    expect(
      (
        await asUser(
          owner,
          "select name from storage.objects where bucket_id='walkthrough-reports';",
        )
      )[0].rows,
    ).toHaveLength(1);
    await expect(
      asUser(userA, "select * from public.claim_report_delivery(null);"),
    ).rejects.toThrow();
  });
  it("keeps storage private and denies users who have not entered the workspace", async () => {
    await db.exec("reset role;");
    expect((await db.query("select public from storage.buckets where id in ('walkthrough-media','walkthrough-reports')")).rows).toEqual([{ public: false }, { public: false }]);
    const result = await asUser(outsider, "select id from public.walkthroughs; select name from storage.objects; select id from public.report_deliveries;");
    expect(result.map((table) => table.rows)).toEqual([[], [], []]);
    await db.exec(`reset role; insert into storage.objects(bucket_id,name) values('walkthrough-media','99999999-9999-4999-8999-999999999999/other/file');`);
    expect((await asUser(userA, "select name from storage.objects where name like '99999999%';"))[0].rows).toEqual([]);
  });
  it("caps paid processing per anonymous session without allowing direct quota resets", async () => {
    for (let i = 0; i < 20; i++)
      expect(
        (
          await asUser(
            userA,
            "select public.consume_field_ai_budget() as allowed;",
          )
        )[0].rows,
      ).toEqual([{ allowed: true }]);
    expect(
      (
        await asUser(
          userA,
          "select public.consume_field_ai_budget() as allowed;",
        )
      )[0].rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await asUser(
          userB,
          "select public.consume_field_ai_budget() as allowed;",
        )
      )[0].rows,
    ).toEqual([{ allowed: true }]);
    await expect(
      asUser(userA, "delete from private.ai_daily_usage;"),
    ).rejects.toThrow();
  });
});
