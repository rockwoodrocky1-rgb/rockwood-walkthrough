# Rockwood Walkthrough

This repository is the client-owned internal app for one development company and multiple construction projects. Keep the marketing website separate. Future Gantt/project management features extend the project model; they must not replace visit evidence or report IDs.

Read README.md and .env.example before changing integrations. Never read or print secrets unnecessarily. Real secrets belong only in ignored .env.local or the client hosting secret store. Do not put secret/service-role keys in NEXT_PUBLIC_ variables, git, artifacts, screenshots or logs.

Use Node 22 and npm ci. Validate substantive changes with npm run lint, npm run typecheck, npm test, npm run build. GitHub Actions runs the same checks. Keep the exact supplied brand logo unchanged.

Supabase project vyvwqullxdyeympptyix is the client's shared TEST workspace. Migrations must be generated with `npx supabase migration new <name>` and reviewed before application. Baseline SQL was applied in the dashboard; reconcile migration history before running db push. Access checks in supabase/tests use transactions and roll back. All user-data tables require explicit RLS, grants and workspace membership. Never make photos, audio or report PDFs public.

Report delivery is a durable database outbox. Preserve atomic insertion, immutable snapshots, unique report delivery IDs, exclusive leases, server-only job updates and email deduplication rules. The only current recipient/sender for Gmail is rockwoodrocky1@gmail.com. Never enable real email in CI or a preview automatically. Provider acceptance is not proof of inbox delivery. The PDF is the first-created version; the authenticated report link shows saved edits.

Vercel team rockwood1 and GitHub rockwoodrocky1-rgb belong to the client. Verify account/team/project before deployment, not the operator's personal account. The user authorized a free test deployment and declined paid upgrades. The repository has no scheduled cron so it fits Hobby's technical limits; opening a report starts its PDF worker. Vercel's separate commercial-use rules still apply. Keep production keys out of preview branches and untrusted builds. The old temporary tunnel depends on this Mac remaining awake; a Vercel deployment does not.

Hosted test app: https://rockwood-walkthrough.vercel.app/ in Vercel project rockwood1/rockwood-walkthrough. The client approved the repository-specific GitHub installation and the Supabase test secret in this project's main Production environment. Auth redirects and report links use this hosted URL. Live AI and automatic email remain disconnected. Verify Vercel's actual source commit and status after a push; do not assume a GitHub push is a successful deployment.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

This checkout is the unpublished `feat/name-phone-spanish` branch. The user explicitly said no push or merge. Read BRANCH_NOTES.md before continuing. No live Supabase migration, auth setting, email sender, AI credential or deployment has been changed for this branch. Field contacts are unverified contact data. Do not weaken the contributor isolation, trust a phone number as identity, expose storage buckets, or log report capability URLs.
