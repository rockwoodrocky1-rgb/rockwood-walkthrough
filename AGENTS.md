# Rockwood Walkthrough

AWS pilot integration instructions and activation status are in AWS_SETUP.md. The user confirmed the Puestario AWS pilot account and approved creating the Rockwood Gmail SES identity on October 14, 2026, but deferred the final domain/sender and automatic email. Do not activate email or drain historical deliveries. Infrastructure defaults to a disabled worker/schedule; apply the processing migration before setting AI_PROVIDER=aws. The repository is public. No secret values belong in the template or worker bundle. A compiled adapter, active model profile, or passing mock test is not a verified live transcription.

This repository is the client-owned internal app for one development company and multiple construction projects. Keep the marketing website separate. Future Gantt/project management features extend the project model; they must not replace visit evidence or report IDs.

Read README.md and .env.example before changing integrations. Never read or print secrets unnecessarily. Real secrets belong only in ignored .env.local or the client hosting secret store. Do not put secret/service-role keys in NEXT_PUBLIC_ variables, git, artifacts, screenshots or logs.

Use Node 22 and npm ci. Validate substantive changes with npm run lint, npm run typecheck, npm test, npm run build. GitHub Actions runs the same checks. Keep the exact supplied brand logo unchanged.

Supabase project vyvwqullxdyeympptyix is the client's shared TEST workspace. Migrations must be generated with `npx supabase migration new <name>` and reviewed before application. Baseline SQL was applied in the dashboard; reconcile migration history before running db push. Access checks in supabase/tests use transactions and roll back. All user-data tables require explicit RLS, grants and workspace membership. Never make photos, audio or report PDFs public.

Report delivery is a durable database outbox. Preserve atomic insertion, immutable snapshots, unique report delivery IDs, exclusive leases, server-only job updates and email deduplication rules. The only current recipient/sender for Gmail is rockwoodrocky1@gmail.com. Never enable real email in CI or a preview automatically. Provider acceptance is not proof of inbox delivery. The PDF is the first-created version; the authenticated report link shows saved edits.

Vercel team rockwood1 and GitHub rockwoodrocky1-rgb belong to the client. Verify account/team/project before deployment, not the operator's personal account. The user authorized an owner-operated publishing setup on October 12, 2026 and is willing to review an upgrade if necessary; no paid checkout is authorized yet. The repository has no scheduled cron so it fits Hobby's technical limits; opening a report starts its PDF worker. Vercel's separate commercial-use rules still apply. Keep production keys out of preview branches and untrusted builds. The old temporary tunnel depends on this Mac remaining awake; a Vercel deployment does not.

Hosted test app: https://rockwood-walkthrough.vercel.app/ in Vercel project rockwood1/rockwood-walkthrough. The client approved and saved Vercel GitHub App access to all current/future rockwoodrocky1-rgb repositories on October 12, 2026, and previously approved the Supabase test secret in this project's main Production environment. Auth redirects and report links use this hosted URL. Live AI and automatic email remain disconnected. Verify Vercel's actual source commit and status after a push; do not assume a GitHub push is a successful deployment.

Owner publishing: Vercel's signed-in owner is linked to GitHub rockwoodrocky1-rgb; GitHub confirms rockwoodrocky1@gmail.com is verified and supplies 341578810+rockwoodrocky1-rgb@users.noreply.github.com for private commit attribution. The user expressly chose this owner-operated setup. This repository's local Git identity is Rockwood Development with that no-reply address. Use the client-scoped GitHub CLI configuration in ignored qa/client-github for authenticated publishing; do not change global Git identity, use unrelated accounts, or rewrite existing authorship. Historical Blazecamp commits remain intact. Separate human contributors require the platform's supported collaboration setup.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

The user authorized merging `feat/name-phone-spanish` into `main` and pushing on October 12, 2026, superseding the earlier branch-only restriction. Read BRANCH_NOTES.md before activating the feature on the hosted app. The field-contact and shared-property migrations were applied together in the client SQL Editor on October 12, 2026 and Anonymous Sign-Ins enabled. Email sender and AI credentials remain unconfigured. Earlier deployments were blocked because local Git used the operator's Blazecamp identity; the approved owner publishing configuration above applies only to new work. Field contacts are unverified contact data. The user explicitly approved shared reading: every registered name/phone session can read all property visits, evidence and delivery status in this workspace. Contributors edit only their own visits; owners can edit all. Preserve write ownership and workspace boundaries. Never trust a phone number as identity, expose storage buckets, or log report capability URLs.
