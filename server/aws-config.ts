import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import { createBedrockRuntime } from "./aws-bedrock";

/** Availability is configuration-only; it never requests credentials or calls AWS. */
export function awsProcessingConfigured() {
  return Boolean(
    process.env.AWS_PROCESSING_ENABLED === "true" &&
      process.env.ROCKWOOD_AWS_REGION?.trim() &&
      process.env.AWS_BEDROCK_MODEL_ID?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() &&
      (process.env.VERCEL !== "1" || process.env.AWS_ROLE_ARN?.trim()),
  );
}

/** Pin the resource region; Vercel's automatic AWS_REGION is its execution region. */
export function awsClientOptions(): {
  region: string;
  credentials?: BedrockRuntimeClientConfig["credentials"];
} {
  const region = process.env.ROCKWOOD_AWS_REGION?.trim();
  if (!region) throw new Error("Rockwood AWS region is not configured.");
  if (process.env.VERCEL === "1") {
    const roleArn = process.env.AWS_ROLE_ARN?.trim();
    if (!roleArn) throw new Error("Rockwood AWS role is not configured.");
    return {
      region,
      credentials: awsCredentialsProvider({ roleArn }),
    };
  }
  // Lambda's execution role uses the SDK's native credential chain. Never
  // fall through to this branch on Vercel when its OIDC role is missing.
  return { region };
}

export function awsBedrockModel() {
  const modelId = process.env.AWS_BEDROCK_MODEL_ID?.trim();
  if (!modelId) throw new Error("Rockwood AWS model is not configured.");
  return modelId;
}

export function awsBedrockRuntime() {
  return createBedrockRuntime(awsClientOptions());
}
