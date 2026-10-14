import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { processReportJob } from "./processing-worker";
import { processDelivery, workerClient } from "./delivery";

let loaded = false;
async function loadServerSecret() {
  if (loaded) return;
  const arn = process.env.ROCKWOOD_SERVER_SECRET_ARN;
  const region = process.env.ROCKWOOD_AWS_REGION;
  if (!arn || !region) throw new Error("Worker configuration missing.");
  const client = new SecretsManagerClient({region, maxAttempts: 1});
  const value = await client.send(new GetSecretValueCommand({SecretId: arn}), {abortSignal: AbortSignal.timeout(15_000)});
  const secret = z.object({SUPABASE_SECRET_KEY: z.string().min(20)}).parse(JSON.parse(value.SecretString ?? "{}"));
  process.env.SUPABASE_SECRET_KEY = secret.SUPABASE_SECRET_KEY;
  loaded = true;
}
export async function handler() {
  if (process.env.AWS_PROCESSING_ENABLED !== "true") return {enabled: false};
  await loadServerSecret();
  const client = workerClient();
  const report = await processReportJob(client);
  // The existing leased outbox creates the private PDF and sends it independently
  // of browser requests. Single delivery per tick also respects SES sandbox rates.
  const delivery = await processDelivery(undefined, client);
  return {processed: report.processed, delivery: delivery.processed};
}
