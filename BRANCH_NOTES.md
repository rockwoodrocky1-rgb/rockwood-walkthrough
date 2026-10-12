# Name, phone, and Spanish walkthrough branch

Source branch: `feat/name-phone-spanish`. Base: `ace615d`. On October 12, 2026, the user approved merging into `main` and pushing to the client repository. This supersedes the earlier branch-only restriction. Hosted activation still depends on the setup and cloud verification below; a successful Git push alone does not make this feature ready online.

Before this merge, Vercel blocked the prior `main` deployment (`ace615d`) because its commit author did not have contributing access. The dashboard says Hobby does not support collaboration for private repositories. The existing public test URL still served the previously verified version. Resolve deployment access through the client's supported account configuration; do not rewrite author identity to bypass that restriction or start a paid plan without authorization.

The user subsequently chose owner-operated publishing. Rockwood's Vercel owner is already connected to GitHub `rockwoodrocky1-rgb`. The repository-local identity now uses Rockwood Development and that account's GitHub-provided no-reply address for new work; historical commit identities are unchanged. Vercel's GitHub App has the user-approved access to all repositories in that client account. The owner-approved field-contact and shared-property migrations were applied together to the test project on October 12, 2026, and Anonymous Sign-Ins enabled. No paid plan or automatic email sender has been activated.

## What is implemented

- Entry requires a name and phone only. There is no email link, password, SMS, verification code or MFA in the field workflow. Supabase anonymous sessions provide invisible per-browser write ownership; the contact details are self-reported, not verified identity. At the owner's request, every registered session can read all property reports in this workspace. A phone number never claims another person's identity or write access. Changing person starts a separate session. Anyone with the app link can enter and read the workspace reports.
- English/Spanish controls cover entry, projects, areas, recording, permission/recovery messages, photo details, notes, report review/editing, delivery status and dialogs. The preference persists on that browser; toggling keeps the current capture and drafts intact. Project proper names and original evidence are preserved.
- Visits store submitter name/phone and source language. The database stamps contact details from the contributor's own contact row and freezes them with the original visit. Everyone who enters can read all workspace visits, photos and PDFs. Company owners can edit all visits; field contributors can edit only their own visits and upload their own media. Both storage buckets remain private. Visit history loads in batches until all records are retrieved.
- AI reports request English prose. Spanish manual drafts and report edits pass through a separate English translation endpoint before saving a report. Translation changes only text slots; evidence IDs, source links, statuses, priorities and assignees remain unchanged. Missing/duplicate translation slots fail instead of replacing the report. Original audio/notes/transcripts remain in their source language. Translation occurs when preparing/saving the report, not as live simultaneous speech translation.
- The existing transactional outbox creates one PDF/email job per report ID. Spanish source cannot queue a report until its English output is ready. PDF/email output is English; the PDF includes submitter contact, English report text, photos/captions and a review link. Original-language photo notes remain available online instead of leaking untranslated text into the English PDF.
- Email links are read-only capabilities for one visit. Recipients do not sign in. The HMAC token is scoped to workspace + visit and checked on the server before any private data is loaded. Buckets remain private; photo/audio/PDF URLs expire after five minutes. Anyone given the report link can read that visit. Archiving the visit revokes its link; rotating the server secret invalidates all these links. Do not publish those URLs or log query strings. The shared page uses no-referrer and no-store and cannot edit reports.
- The migration includes atomic processing budgets: 20 AI route requests per browser session per day, 100 across the company per day. A report request may make a generation and a translation provider call. These are request limits, not dollar caps; keep provider-side spend limits too.

## Local preview

```sh
npm ci
npx next dev --hostname 127.0.0.1 --port 8791
```

Open http://127.0.0.1:8791/. No `.env.local` or client credentials were copied to this branch checkout. This local preview is explicitly device-only; it never writes to the live client workspace. The main checkout's port 8790 and the Vercel test URL remain separate.

Without AI credentials, Spanish source can be captured/saved but English report preparation shows a clear pending-connection message. It never pretends to translate. English manual reports and fictional sample reports can still be tested. The source and report controls remain available in either language.

## Connections needed before hosted activation

1. The baseline was applied in the dashboard; do not run db push until its migration history is reconciled. Validate `20261012194009_field_contacts_and_english_reports.sql` and `20261012202423_shared_property_report_access.sql` together, then apply only these pending migrations in one transaction and enable Supabase Anonymous Sign-Ins. The owner approved shared reading of all property reports, with private buckets and creator/owner writes.
2. Verify the hosted environment's public Supabase URL/key and server-only key refer to the intended client test project. Use separate credentials for an isolated preview; never reuse main Production secrets in an untrusted preview. `APP_URL` must match the hosted origin so new PDF/email links point to it.
3. Connect client-owned OpenAI credentials and enable `LIVE_AI_ENABLED` with exact `ALLOWED_ORIGINS`. The UI toggle itself does not need AI. Genuine translation/transcription was not tested with a paid provider key in this branch.
4. Connect an authorized email sender. The current Gmail mailbox is a recipient, not an automatic sending credential. `GMAIL_APP_PASSWORD` or the already-supported transactional sender is still needed for unattended email; none was created or enabled. No email was sent from this branch. The worker must be invoked after report creation; the existing report screen does this. Scheduled retry remains a separate hosting configuration, not enabled on Hobby by this branch.
5. Run a cloud smoke test: enter name/phone in two separate browser sessions, capture Spanish narration/photo notes, verify the original Spanish evidence and saved English report, verify private PDF generation, verify receipt at `rockwoodrocky1@gmail.com`, and open the emailed read-only link in a new browser with no session. Confirm visitor A can read visitor B's reports, media and PDF status, but cannot edit B's records or files. Confirm a session that has not entered name/phone cannot read workspace records.

## Verification

October 12, 2026: lint and type-check passed, **67 unit/database tests passed**, and the production build passed. Both pending field-contact/shared-property migrations were applied together to the live test database, and Anonymous Sign-Ins enabled. No paid AI or automatic email provider call ran.

The local unit suite includes a real PostgreSQL engine (PGlite) exercising all committed migrations, contributor RLS, contact stamping, shared property reads, creator-only writes, private media/PDF workspace boundaries, forged evidence paths, outbox deduplication, English-output gating and request budgets. Translation provider calls are mocked; tests verify faithful slot replacement and preservation of references/source. Report links are tested against tampered workspace/visit/token and secret rotation.

Manual Chrome QA at 390 px verified Spanish entry, local name/phone entry, project selection, Spanish area labels, saving Spanish notes, photo upload, toggling without losing evidence, and the honest failure state with translation disabled. No horizontal overflow in the tested source view. Reload restored the Spanish interface and source notes; an English manual report included the supplied name/phone. Entry layout was also checked at 320 and 430 px. This does not claim a physical iPhone camera or a live provider/email test.

Supabase anonymous-session reference: https://supabase.com/docs/guides/auth/auth-anonymous
OpenAI structured output reference: https://developers.openai.com/api/docs/guides/structured-outputs
