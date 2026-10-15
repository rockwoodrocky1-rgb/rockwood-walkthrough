import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { processReportJob } from "./processing-worker";
import { processDelivery, workerClient } from "./delivery";

let loaded = false;
let workspaceConnection: { url: string; key: string; appUrl: string } | undefined;
async function loadServerSecret() {
  if (loaded) return;
  const arn = process.env.ROCKWOOD_SERVER_SECRET_ARN;
  const region = process.env.ROCKWOOD_AWS_REGION;
  if (!arn || !region) throw new Error("Worker configuration missing.");
  const client = new SecretsManagerClient({region, maxAttempts: 1});
  const value = await client.send(new GetSecretValueCommand({SecretId: arn}), {abortSignal: AbortSignal.timeout(15_000)});
  const secret = z.object({
    SUPABASE_SECRET_KEY: z.string().min(20),
    WORKSPACE_SUPABASE_URL: z.url().optional(),
    WORKSPACE_SUPABASE_SECRET_KEY: z.string().min(20).optional(),
    WORKSPACE_CAM_URL: z.url().optional(),
  }).parse(JSON.parse(value.SecretString ?? "{}"));
  process.env.SUPABASE_SECRET_KEY = secret.SUPABASE_SECRET_KEY;
  if (secret.WORKSPACE_SUPABASE_URL && secret.WORKSPACE_SUPABASE_SECRET_KEY && secret.WORKSPACE_CAM_URL)
    workspaceConnection = { url: secret.WORKSPACE_SUPABASE_URL, key: secret.WORKSPACE_SUPABASE_SECRET_KEY, appUrl: secret.WORKSPACE_CAM_URL };
  loaded = true;
}
export async function handler() {
  if (process.env.AWS_PROCESSING_ENABLED !== "true") return {enabled: false};
  await loadServerSecret();
  async function processDatabase(connection?: typeof workspaceConnection) {
    const client = workerClient(connection);
    const report = await processReportJob(client);
    const delivery = await processDelivery(undefined, client, connection
      ? { appUrl: connection.appUrl, authenticatedLinks: true, emailEnabled: false } : undefined);
    return { processed: report.processed, delivery: delivery.processed };
  }
  // Independent queues and leases: a legacy failure cannot prevent attempting
  // workspace jobs. Neither key is installed into a browser or Vercel runtime.
  const results = await Promise.allSettled([
    processDatabase(), ...(workspaceConnection ? [processDatabase(workspaceConnection)] : []),
  ]);
  return { databases: results.map(result => result.status === 'fulfilled' ? result.value : { failed: true }) };
}
