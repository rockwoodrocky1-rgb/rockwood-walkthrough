# Rockwood Walkthrough

This repository is the client-owned internal app for one development company and multiple construction projects. Keep the marketing website separate. Future Gantt/project management features extend the project model; they must not replace visit evidence or report IDs.

Read README.md and .env.example before changing integrations. Never read or print secrets unnecessarily. Real secrets belong only in ignored .env.local or the client hosting secret store. Do not put secret/service-role keys in NEXT_PUBLIC_ variables, git, artifacts, screenshots or logs.

Use Node 22 and npm ci. Validate substantive changes with npm run lint, npm run typecheck, npm test, npm run build. GitHub Actions runs the same checks. Keep the exact supplied brand logo unchanged.

Supabase project vyvwqullxdyeympptyix is the client's shared TEST workspace. Migrations must be generated with `npx supabase migration new <name>` and reviewed before application. Baseline SQL was applied in the dashboard; reconcile migration history before running db push. Access checks in supabase/tests use transactions and roll back. All user-data tables require explicit RLS, grants and workspace membership. Never make photos, audio or report PDFs public.

Report delivery is a durable database outbox. Preserve atomic insertion, immutable snapshots, unique report delivery IDs, exclusive leases, server-only job updates and email deduplication rules. The only current recipient/sender for Gmail is rockwoodrocky1@gmail.com. Never enable real email in CI or a preview automatically. Provider acceptance is not proof of inbox delivery. The PDF is the first-created version; the authenticated report link shows saved edits.

Vercel team rockwood1 and GitHub rockwoodrocky1-rgb belong to the client. Verify account/team/project before deployment, not the operator's personal account. The user authorized a free test deployment and declined paid upgrades. The repository has no scheduled cron so it fits Hobby's technical limits; opening a report starts its PDF worker. Vercel's separate commercial-use rules still apply. Keep production keys out of preview branches and untrusted builds. The old temporary tunnel depends on this Mac remaining awake; a Vercel deployment does not.

Hosted test app: https://rockwood-walkthrough.vercel.app/ in Vercel project rockwood1/rockwood-walkthrough. The client approved the repository-specific GitHub installation and the Supabase test secret in this project's main Production environment. Auth redirects and report links use this hosted URL. Live AI and automatic email remain disconnected. Verify Vercel's actual source commit and status after a push; do not assume a GitHub push is a successful deployment.
