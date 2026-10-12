# Rockwood Walkthrough

> **Unpublished feature branch:** this checkout adds name/phone entry and English/Spanish walkthroughs. Read [BRANCH_NOTES.md](BRANCH_NOTES.md) for the current behavior, local preview on port 8791, and connections still pending. The deployment details below describe the unchanged live base version. Do not deploy or apply migrations from this branch yet.

A client-owned shared site-visit prototype with an optional local demo mode: choose a fictional project, record narration while taking still photos, finish, then review an editable report. Built with Next.js App Router, TypeScript, Tailwind/CSS, Zod, the official OpenAI SDK, Supabase Auth/Postgres/private Storage, and temporary recovery storage via idb-keyval.

## Start

Requires Node.js 22.14+ and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:8790** in a normal browser tab. For the production build:

```sh
npm run build
npm start
```

Both commands bind to loopback by default. `.npmrc` enables legacy peer resolution to avoid an npm 10 optional-peer resolution crash; the committed lockfile is reproducible. No database server, account, or API key is needed for local capture and manual/sample reports.

## Sample, manual, and Live AI modes

- **Sample reports** are deterministic fictional fixtures, explicitly labeled on screen and in print. Viewing them makes no AI/API requests. They never analyze a new recording.
- **Capture** uses a real camera preview, real audio-only MediaRecorder, and canvas stills on shutter taps. Taking photos does not stop audio. Uploaded JPEG/PNG/WebP plus typed notes are available when devices or permissions are unavailable. HEIC is rejected honestly.
- **Manual reports** let you document and edit notes, observations, captions and tasks without AI. They are marked manually prepared.
- **Live AI** transcribes the completed recording, saves the transcript, then generates an evidence-linked report from that transcript, photos and notes. Failures keep the session and offer retry/manual input. Report retries reuse an already saved transcript; no fictional fallback occurs.

The server includes only the Live-mode boolean in the initial page. With AI disabled, **Done saves and opens the review without any AI request**. In cloud mode it uploads to Supabase and clearly marks failed uploads for retry; in local demo mode Done makes no network requests. An explicit **Check AI availability** action can recheck the server later. Configured Live mode still processes after Done. Interrupted requests and timeouts explain what failed and how to retry; previously saved “Fetch is aborted” messages also receive a readable recovery explanation.

To enable real processing, copy `.env.example` to `.env.local` and set:

```dotenv
OPENAI_API_KEY=your-server-side-key
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_REPORT_MODEL=gpt-4.1-mini
LIVE_AI_ENABLED=true
ALLOWED_ORIGINS=http://localhost:8790,http://127.0.0.1:8790
```

Restart the server after changing environment variables. Never use a `NEXT_PUBLIC_` variable for an OpenAI key, Supabase secret/service-role key, database password, or other privileged credential. Supabase’s publishable key is intentionally public and is safe only with the supplied access policies. `/api/config` exposes only a boolean. `/api/transcribe` and `/api/report` are disabled unless both the explicit flag and key are present. Live AI is currently disabled. When Supabase is configured, both paid routes also verify the bearer token and require an owner/editor workspace membership. Before enabling paid AI publicly, configure a client-owned API key, quotas/rate limits, and the exact allowed origins. Unconfigured local-demo mode has only origin checks, which are not authentication.

Whisper receives `verbose_json` and segment timestamp parameters. Other configured transcription models receive JSON only and return null timing; choose a model supporting that format. Reporting uses Responses with structured output, local Zod/evidence validation, `store: false`, a 90-second provider timeout, and no automatic paid retries. `store: false` does not itself promise zero provider retention. Live processing sends media and notes to OpenAI; use non-sensitive test material. See the [official transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) and [structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

## Test on a phone

Camera/microphone access requires a browser-trusted **HTTPS** origin or localhost. A phone opening `http://<computer-LAN-IP>:8790` is not opening localhost. Use Safari/Chrome directly, not an embedded iframe browser.

One secure option is a private Tailscale Serve URL:

1. Connect your computer and phone to your own trusted Tailscale network; enable HTTPS as prompted.
2. Keep `npm start` running after a build. In another terminal, run `tailscale serve http://127.0.0.1:8790` and open its printed HTTPS URL on the phone. Serve is private to your tailnet; do not use public Funnel for enabled Live endpoints. This is a testing transport, not an app integration. [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
3. If enabling Live AI, add that exact HTTPS origin to `ALLOWED_ORIGINS` and restart this app. Restrict the tailnet to trusted testers.
4. Record a short visit, take two photos, pause/resume, tap Done, listen to the audio, and reopen the saved visit. End Serve with Ctrl+C when finished.

An existing trusted HTTPS reverse proxy is equally suitable. Open Safari or Chrome directly on the phone. Keep the page open and the phone unlocked. Hiding the page or muting/disconnecting a track pauses/stops capture honestly; background recording is not promised. The revised camera layout still needs a physical-phone retest; automated WebKit layout checks are described below.

### Public testing

The hosted test URL is **https://rockwood-walkthrough.vercel.app/**. It runs on the client's Vercel account and does not require this Mac. Testers open it directly in Safari or Chrome and sign into the Rockwood workspace. Completed uploads are shared through the client’s Supabase project. Only verified, approved workspace members can read project data. Live AI is disabled, so use sample reports or prepare a manual report after recording.

The previous Cloudflare URL, `https://recordings-color-state-leader.trycloudflare.com/`, remains a separate temporary local-development preview. Only that old URL requires the Mac to stay awake and the app/tunnel to run. Older PDFs preserve the URL used when first generated; new hosted reports use the Vercel URL. The optional tunnel command is `./qa/preview-tools/cloudflared tunnel --url http://127.0.0.1:8790 --no-autoupdate --protocol http2`. Restarting it changes its URL. Its downloaded tool is excluded from source control. See the [Quick Tunnels reference](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Storage, limits, and recovery

All limits are in `shared/model.ts`:

- **Five active minutes / twelve photos** per walkthrough. Pause time is excluded from both the timer and camera-photo timestamps. Uploaded photos have null recording time.
- Audio targets **64 kbps**, with actual byte checks and early stop near the upload limit. Recording uses only audio tracks; video is never recorded or uploaded.
- Model images use at most **1280 px** on the long edge and an actual encoded limit of **150 KB** each; larger local JPEG derivatives retain up to 1920 px. Original uploaded files are not retained byte-for-byte. Downloads return the stored derivative.
- Each inbound request is limited to **3,000,000 bytes**, including multipart/base64 overhead. Both client and streamed server reads enforce it before paid calls. Provider/deployment limits may differ. Oversized audio remains downloadable; it is not silently renamed or transcoded.

### Shared Rockwood storage

Client Supabase project: **Rockwood Walkthrough — Test**, organization **Rockwood Development**, region **us-east-1**, reference `vyvwqullxdyeympptyix`. The signed-in organization owner account is `rockwoodrocky1@gmail.com`. The initial app-owner invitation is for that verified email; app membership and Supabase dashboard ownership are separate.

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local` and the hosting environment. Both are public connection settings. Browser capture and shared storage do not need a privileged key. The separate PDF/email worker requires the server-only `SUPABASE_SECRET_KEY` described below; no database password is used by the app. Build again after changing public environment variables.

The schema is in `supabase/migrations/20261012180049_rockwood_shared_walkthroughs.sql`. It and `20261012182342_restrict_auto_rls_helper.sql` were applied through the signed-in SQL Editor on October 12, 2026 because the Supabase connector was not connected. **Do not rerun this baseline against the existing project.** Before enabling CLI/GitHub database deployments, reconcile migration history with these already applied migrations. `supabase/tests/access.sql` passed against the live project in a rolled-back transaction: member writes, outsider isolation, immutable ownership, revision checks, private media and protected invitation claiming. Supabase Security Advisor then reported zero errors and zero warnings; its one informational notice is the intentionally inaccessible private invitations table having RLS with no direct-access policy.

- `workspaces`, `workspace_members`, `projects`, `walkthroughs`: explicit grants and RLS; anonymous reads/writes are denied. Members see their workspace; owners edit all visits; editors edit their own; viewers only read.
- `walkthrough-media`: private, immutable photo/audio objects. Metadata commits only after every asset uploads successfully. Files use content-hash paths so upload retries do not replace existing media.
- Reports, notes, transcripts and photo metadata are stored with each visit’s versioned JSON document. This can later be normalized into tasks/documents without losing the original evidence.
- Database revision checks prevent silent overwrites from another device. A conflicting edit stays in the local recovery copy for review; it is not automatically merged.
- The list loads the latest 100 visit records; media downloads only when opening a visit. Paging/search and large-file resumable uploads remain production expansion work.
- Archive hides a visit while retaining the record and media. A database administrator can restore it by clearing `archived_at` and incrementing `revision`. Old immutable media versions are retained; establish a retention/backup plan before real production use.

Recording and unfinished uploads use account-scoped IndexedDB recovery stores. A successful cloud upload removes that recovery copy; opening shared media loads it into browser memory. Captured bytes necessarily pass through the browser while recording. Files are never automatically added to the phone’s Photos or Files apps. Keep the tab open during upload. An interrupted recording can recover chunks only if the browser delivered and persisted them; unfinished audio may not play.

The original anonymous prototype stores remain untouched. Earlier recordings are still in the original browser **and origin**, not automatically imported into the shared account. Switching from ChatGPT’s embedded browser to Safari does not transfer that data. A deliberate import/export flow is still needed for those old captures.

### Team sign-in and hosting

The app uses Supabase email links and claims only invitations prepared by an administrator after checking the actual verified email in `auth.users`. Browser-supplied user metadata cannot grant membership. Additional teammates must be added deliberately to `private.workspace_invitations` with an appropriate role; no teammate invitations have been sent.

Supabase’s default email service is restricted to organization-team addresses. Configure a client-owned SMTP provider and sender domain before inviting Mateo or other field testers. Do not give field users Supabase dashboard access as an email-delivery workaround. See [Supabase SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp).

Supabase stores data; Vercel hosts the Next.js frontend and PDF worker. The client-owned `rockwood1/rockwood-walkthrough` project is deployed on Hobby at `https://rockwood-walkthrough.vercel.app/`. Supabase's Auth Site URL and exact redirect allowlist include that address. The hosted main environment has the public Supabase connection, encrypted server key, `APP_URL`, `ALLOWED_ORIGINS`, and `REPORT_DELIVERY_ENABLED=true`. Live AI remains disabled, email credentials are absent, and no cron is scheduled. No paid hosting subscription has been started. Hosting-plan eligibility must be revisited for commercial operation.

### Optional local demo

With both public Supabase environment variables absent, the original standalone demo remains available. Sessions/media use `rockwood-walkthrough-v1` and chunks use `rockwood-audio-v1`. Browser data is specific to a device/profile/origin; clearing it removes local demo records. Reset demo data exists only in this mode. No login or cloud upload occurs.

## Reports and branding

Reports distinguish narration, visible photo evidence, user notes, reported completion, requested review and proposed follow-ups. Evidence uses stable IDs; missing or cross-session IDs fail validation. Timestamp proximity never creates an automatic photo association. Unknown people and deadlines stay unassigned. AI prose still requires human review.

Edit the summary, observations, areas, photo associations/captions, tasks, assignees and due-date wording. Save explicitly. Mark reviewed saves the report’s review status; later changes return it to Draft. Source edits invalidate review and remove obsolete evidence links. Regeneration warns before replacing a report. Print / Save as PDF opens the browser print flow with current edits. Cloud manual/live reports also receive a privately stored server-generated PDF as described below.

`public/brand/rockwood-logo.png` is the kit’s original **578 × 158 raster**, copied byte-for-byte. No crop, filter, tracing, recoloring or replacement. `BRAND_TOKENS.css`, `CODEX_PROMPT.md` and `TECHNICAL_REFERENCES.md` are retained from the supplied kit. Project-cover images are locally stored illustrative references reused from the existing project’s licensed asset collection, not Rockwood job photos; attribution is in `public/images/source-credits.json`.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:e2e
```

Verified October 12, 2026: **51 unit tests passed**, plus production build, type-check and lint. Anonymous calls to all four live database tables and the membership-claim RPC were rejected. Live transaction-only access and delivery-queue tests passed. The owner signed in, uploaded a labeled test photo and notes, reopened them after reload, created a manual report, and generated a two-page PDF in private Storage. Both PDF pages were rendered and visually checked. A one-off browser Gmail message with that PDF and report link was sent to and received by `rockwoodrocky1@gmail.com`. Its link reopened the correct cloud report and photo at 390 px with no horizontal overflow. This verifies the Gmail test message, not unattended SMTP delivery. Runtime dependency audit is clean (`npm audit --omit=dev`). The full audit reports five linked advisories in development-only lint dependencies; no runtime downgrade was applied.

The final Supabase Security Advisor check reports zero errors, one Auth warning for disabled leaked-password protection, and the expected private-invitations informational notice. The current app uses email links, not passwords. Revisit Auth protections before introducing password sign-in; no account security settings were weakened for testing.

Hosted verification on October 12, 2026: Vercel deployment `32PYiqyPqTdprNMCDJVzgbcHkmEg` reached Ready from commit `3d3f73c`. A real email-link sign-in returned to the Vercel address and loaded the existing workspace. A fresh illustrative photo and notes were uploaded through that site; Vercel generated a new two-page PDF in private Supabase Storage with a verified link to the hosted report. Reload restored the photo and notes, and the report fit a 390 px viewport without horizontal overflow. Unauthenticated report/worker requests returned 401. Test visit: `36c87eab-f353-42fb-a385-b818b53706d0`. No new email was sent by the worker.

Browser tests use **simulated Chromium camera/microphone devices** and mocked AI responses. They exercise the real browser recording/canvas/IndexedDB implementation, final-chunk retention, permission failure, pause/resume, retry recovery, editing, printing, project isolation, responsive layouts, offline Done without API requests, and interrupted AI checks. A separate WebKit check through the public HTTPS preview verified centered, full-width camera frames at 320, 390 and 430 pixels; it used a simulated permission denial, not a physical camera. The user's initial iPhone test was in ChatGPT's embedded browser; the revised build has not yet been physically retested. No real-key provider call was made. QA images and the browser-generated print PDF are kept locally in ignored `qa/`.

## Outside this prototype

No video recording, background capture, live speech recognition, HEIC conversion, long-recording transcoding, automatic offline background synchronization, formal approval workflow, task integrations, messaging, payments, or construction/compliance certification. Shared storage and sign-in are a testing foundation; they are not a full project-management system. There is no analytics or user-content logging. Three sample projects are fictional; no client, address, budget or completed Rockwood work is claimed.

## Report PDF and email workflow

Rockwood is one company workspace with many construction projects. Each visit belongs to a project; report deliveries belong to the same workspace and visit. The marketing website remains separate.

When a manual or live report is first saved, the database trigger inserts a `report_deliveries` outbox row in the same transaction. It freezes the report revision, project name and evidence paths. Re-saving the same report ID never queues another email. Fictional sample reports are excluded; real test captures in fictional projects are labeled TEST in the email/PDF.

The server worker downloads the photo derivatives, creates a branded PDF, and saves it in the private `walkthrough-reports` bucket. When an email sender is configured, it submits the PDF attachment and an authenticated report link. That link displays current edits, stored photos, audio and notes. The PDF preserves the first-created version. Provider acceptance is shown as “submitted for email”; inbox delivery is not claimed without receipt verification.

Current test mode generates and stores PDFs without an email credential. The client declined Gmail 2-Step Verification and a separate sending provider, so unattended email remains disconnected. The UI offers **Download PDF** and **Draft email with report link**; the draft action opens the user's mail app and the PDF must be attached manually. The verified one-off test message was sent through the signed-in Rockwood Gmail browser and recorded as delivered by the administrator to avoid a future duplicate. It does not establish automatic sending for later reports. No Gmail security settings were changed.

`POST /api/deliveries?workspace=<uuid>&report=<report-id>` requires a verified owner or the visit's editor and schedules immediate processing with Next.js `after()`. `GET` requires workspace membership and returns status plus a five-minute private PDF download URL. The optional `GET /api/cron/report-deliveries` is protected by `CRON_SECRET` and drains up to three queued jobs per invocation. No cron is enabled in the current free test deployment: opening a saved report starts its due job once the server PDF connection is configured. Failed jobs stay in Supabase for a later attempt. Without a sender, PDF preparation leaves the email queued and never reports it sent. A five-minute cron may be added later on a suitable plan; Hobby permits only daily cron schedules.

### Server secrets (never commit)

- `REPORT_DELIVERY_ENABLED=true` only in the intended test/production environment; leave previews disabled.
- `APP_URL`: exact public site origin used for report links.
- `SUPABASE_SECRET_KEY`: the client project's secret key (or legacy service-role key), used only by the trusted worker. It bypasses RLS: never expose it to a browser or a preview built from untrusted code.
- `GMAIL_APP_PASSWORD`: Google app password for **rockwoodrocky1@gmail.com**. This fixes both sender and recipient to that client mailbox for testing. Google requires 2-Step Verification; the account owner creates the credential. Gmail password changes revoke app passwords. SMTP uses TLS on port 465.
- `CRON_SECRET`: random server credential for the scheduled worker. Vercel adds it to the cron request's Bearer authorization header.
- Optional future provider: `RESEND_API_KEY` and `REPORT_EMAIL_FROM` (verified sender). Gmail takes precedence if its app password is present. No Resend account is currently required.

A database lease prevents concurrent workers from sending the same job. Before provider submission, the immutable email envelope and send-start time are saved. Gmail SMTP has no idempotency guarantee: if submission is uncertain, the next attempt stops for administrator review instead of risking a duplicate. An administrator must check Gmail's Sent/inbox before resetting that job. Resend retries reuse an idempotency key and exact payload; uncertain submissions stop before its 24-hour deduplication window expires. Preparation failures retry with backoff up to eight attempts. No browser can alter job state or send mail to an arbitrary recipient.

`20261012184005_report_delivery_workflow.sql` and `20261012190440_report_worker_read_access.sql` were applied through the SQL Editor on October 12, 2026. The second grants the trusted worker only the three walkthrough columns needed to check whether a visit was archived. Run `supabase/tests/report-delivery.sql` to verify access, idempotency, leases and uncertainty handling; it rolls all test data back and sends no email. No historical reports are backfilled automatically. Saving an existing manual/live report enqueues it once.

### Client ownership and future agent work

- Source: https://github.com/rockwoodrocky1-rgb/rockwood-walkthrough (private, client-owned).
- Database: Rockwood Development / Rockwood Walkthrough — Test, ref `vyvwqullxdyeympptyix`.
- Hosting: Vercel team `rockwood1` (Rockwood), project `rockwood-walkthrough`, https://rockwood-walkthrough.vercel.app/. The client authorized this free test deployment and declined paid upgrades. The GitHub app is installed only for this repository.
- Website: separate project, outside this app's deployment.
- GitHub Actions validates lint, TypeScript, tests, build and runtime dependency advisories without production secrets.

The test deployment and Supabase connection are configured. Future deployments must target the same client team/project and reviewed `main` source; verify the deployment status and resulting commit rather than assuming every push deployed. Keep the test-project secret scoped to the main Production environment, with Live AI and automatic email disconnected. If changing the domain, update `APP_URL`, Supabase Auth Site URL/redirect allowlist, and `ALLOWED_ORIGINS`, then verify sign-in, photo upload, PDF generation and mobile layout. No paid subscription is authorized. Vercel's [fair-use rules](https://vercel.com/docs/limits/fair-use-guidelines) are separate from these technical settings: testing alone is not a blanket exception for paid client development.

For production later, resolve hosting-plan eligibility, configure the email sender and recurring worker, verify actual email delivery and teammate onboarding, then review usage limits. Do not claim production readiness while these steps remain pending.

The existing SQL-editor migrations are not yet registered in Supabase CLI migration history. Reconcile that history before enabling automatic database deployment; do not replay the baseline. Future scheduling/Gantt data should be separate tables with workspace and project foreign keys, explicit RLS and migrations. Keep the visit IDs and report IDs stable so project management tasks can cite original evidence.
