# AWS pilot foundation

## Deployment state

Prepared October 14, 2026. **The code and infrastructure template are a foundation, not proof of a working live AWS integration.** The processing migration, IAM roles, staging bucket, worker, and Vercel settings require deployment before enabling processing. No real recording has completed this AWS pipeline yet.

The signed-in pilot account is Puestario LLC. Its active $10,000 AWS Activate credit expires October 31, 2028. The console lists Transcribe, Bedrock, S3, Lambda, Secrets Manager, SES, and CloudWatch as eligible services. The `us.amazon.nova-2-lite-v1:0` inference profile is ACTIVE in us-east-1 and routes within us-east-1, us-east-2, and us-west-2. Credits are shared across the pilot account; they are not a separate Rockwood budget or a guarantee against charges after exhaustion/expiry.

An SES identity for `rockwoodrocky1@gmail.com` was created with the user's approval; its status was **verification pending**. The user deferred the final sender/domain and automatic email activation. Keep `EmailEnabled=false` and `REPORT_EMAIL_PROVIDER=disabled`. No Gmail password or 2-Step Verification is required for SES.

## Data flow

1. The phone finishes uploading the visit to the existing private Supabase workspace. Each visit retains its project, author, original audio, photos, notes, and language.
2. `POST /api/process` verifies the browser session and origin. A database RPC checks write ownership, spends the daily quota once, and freezes the saved visit revision in `processing_jobs`. Repeated queue requests reuse that job.
3. A scheduled Lambda claims one leased processing job each minute. It temporarily stages audio in private S3 and starts a deterministic Transcribe job using the selected English or Spanish recording language. That language is preserved separately from the interface toggle. Later ticks poll without holding a browser request open.
4. Original-language speech is checkpointed before Bedrock builds and validates the English report. Photos and notes remain evidence, never instructions. Evidence IDs, unknown assignments, and uncertain findings retain the existing validation rules.
5. A service-only completion RPC checks the original revision, preserves ownership/media, saves the transcript/report, and atomically queues the existing PDF delivery. Edits made during processing cause a visible conflict; generated work is retained instead of overwriting the edits.
6. The existing leased delivery worker builds the branded private PDF. Email stays off until separately configured. The original audio/transcript and current report remain accessible under the project.

The phone may close after upload and queue confirmation. Recording itself still needs the phone awake. Work does not depend on the Mac.

## Deployment sequence

Deploy only in the approved pilot AWS account and the client's existing Supabase/Vercel projects. The template is intended for **us-east-1**. Confirm Vercel uses the **team OIDC issuer** `https://oidc.vercel.com/rockwood1`; the role trusts only `rockwood1/rockwood-walkthrough` Production.

1. Validate and review `infra/aws/rockwood-pilot.json`. Create the `rockwood-pilot` stack with default `WorkerEnabled=false`, empty `WorkerCodeKey`, and `EmailEnabled=false`. The placeholder worker does nothing; the schedule is disabled. This step creates scoped IAM access and requires the operator's approval.
2. Run `npm ci`, the repository checks, and `npm run build:aws-worker`. Upload only `dist/rockwood-worker.zip` to the stack's private bucket under `releases/<commit>.zip`. The bundle contains code, PDF fonts and the exact supplied logo; no environment files.
3. Store the existing Supabase TEST server key privately in the stack's Secrets Manager secret as `{"SUPABASE_SECRET_KEY":"..."}`. Never put its value in a template, source, command line, log or chat. This grants the AWS worker access to Rockwood's private evidence and delivery queue and requires approval for that destination.
4. Review and apply only `20261014151500_durable_report_processing.sql`. The old dashboard-applied migration history remains unreconciled: **do not blindly run `supabase db push` or replay the baseline**. Verify access tests before activation.
5. Update the stack with the uploaded `WorkerCodeKey`. Keep email disabled. Activate the worker only after the secret and database are ready. Native Lambda role credentials are used; do not create long-lived AWS access keys.
6. Set these values in the client's Vercel **Production** environment and redeploy:

```dotenv
AI_PROVIDER=aws
AWS_PROCESSING_ENABLED=true
LIVE_AI_ENABLED=true
ROCKWOOD_AWS_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0
AWS_ROLE_ARN=<VercelRoleArn stack output>
REPORT_EMAIL_PROVIDER=disabled
```

Existing public Supabase settings, server key, exact `ALLOWED_ORIGINS`, `APP_URL`, and report PDF flag stay configured. Set `AI_PROVIDER=aws` only after the processing table exists; it enables progress polling even if new AI work is paused. Do not give preview deployments production keys or AWS access.

7. Test a short known English recording and a short known Spanish recording with a non-sensitive photo. Verify original transcript, English report, matching evidence, private PDF, reload, closed-browser completion, duplicate Done, model failure/retry, and conflicting edits. `GET /api/config` reports configuration, not service health. Do not call the pipeline live-ready until these checks pass.

## Email and domain later

Sender and recipient can change without moving project records, recordings or PDFs. A new sender address/domain must be verified in SES. Sandbox recipients also need verification. Domain ownership/DNS setup is separate from website hosting; Gmail can remain the recipient.

The current pilot recipient is deliberately fixed to `rockwoodrocky1@gmail.com` in both the adapter and IAM policy. Changing it is a reviewed configuration/code change, not a field tester setting. When multiple workspaces are supported, move sender/recipient into owner-managed workspace settings and enforce the same boundary on the server.

For future activation, set `SenderAddress`, `SenderIdentity`, `EmailEnabled=true`, and a real `EmailNotBefore` timestamp. Reports created earlier get PDFs but are held for review, avoiding an unexpected backlog of email. Frozen old email envelopes never silently switch providers. SES/Gmail uncertain submissions stop for review instead of automatically sending duplicates. Provider acceptance alone is not inbox-delivery proof.

## Operating boundaries

- S3 staging expires after seven days; Supabase is the canonical evidence store. S3 public access is blocked and transport requires TLS.
- Only the worker reads the server secret. Vercel's OIDC role invokes the selected Bedrock model for synchronous report edits/translations; it cannot read that secret or S3 evidence.
- Database members can read safe progress and retained results. Only the visit author or workspace owner can enqueue; workers use narrow completion RPCs instead of broad walkthrough UPDATE access.
- Job leases, a 60-minute job deadline, bounded attempts, stable provider names and saved output checkpoints avoid uncontrolled retries. A confirmed terminal transcription failure gets a new provider generation only after explicit retry.
- The pilot region currently has a Lambda concurrency quota of 10. Keep `ReserveWorkerConcurrency=false` (default), so the worker uses shared concurrency. Exclusive database leases still prevent two invocations from processing the same job; the once-per-minute schedule limits ordinary starts, and stale invocation retries are disabled. Reserve one worker execution only after the regional quota is at least 101 and existing reservations leave room for AWS’s required 100 unreserved executions.
- The existing daily budget is 20 processing requests per browser identity and 100 across the workspace. This is not a monetary hard cap. Confirm account budgets/alerts before wider use.
- Pause new HTTP processing with `LIVE_AI_ENABLED=false`. Pause worker execution with stack `WorkerEnabled=false`. Leave the processing table/read API available for inspection. Do not delete source evidence as a pause mechanism.

## Verification before activation

The final CloudFormation template passed AWS `validate-template` in the pilot account. Local lint, TypeScript checks and 205 automated tests passed, including queue ownership, leases, retries, language preservation, output validation and disabled-email handling. These checks do not replace a real English and Spanish recording test after deployment. The AWS resources and new processing migration have not been applied.

## References

- [Vercel AWS OIDC](https://vercel.com/docs/oidc/aws)
- [Amazon Transcribe job settings](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartTranscriptionJob.html)
- [Nova 2 Lite model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html)
- [SES identity verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
