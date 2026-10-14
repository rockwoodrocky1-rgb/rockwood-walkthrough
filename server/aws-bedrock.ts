import {
  BedrockRuntimeClient,
  ConverseCommand,
  type BedrockRuntimeClientConfig,
  type ContentBlock,
  type ConverseCommandOutput,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { LIMITS } from "../shared/model";

/** Credentials and model selection belong to the server's account configuration. */
export function createBedrockRuntime(options: {
  region: string;
  credentials?: BedrockRuntimeClientConfig["credentials"];
}) {
  if (!options.region.trim())
    throw new Error("Bedrock server region is required.");
  return new BedrockRuntimeClient({ ...options, maxAttempts: 1 });
}

export type BedrockConverseClient = {
  send: (
    command: ConverseCommand,
    options: { abortSignal: AbortSignal },
  ) => Promise<ConverseCommandOutput>;
};

/** Send the same evidence labels and JPEG bytes used by the existing report flow. */
export function bedrockPhotoContent(photo: {
  id: string;
  area: string;
  dataUrl: string;
}): ContentBlock[] {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    photo.dataUrl,
  );
  if (!match || match[1].length > Math.ceil(LIMITS.imageTargetBytes / 3) * 4)
    throw new Error("Invalid or oversized JPEG derivative.");
  const bytes = Buffer.from(match[1], "base64");
  if (
    !bytes.length ||
    bytes.length > LIMITS.imageTargetBytes ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.toString("base64").replace(/=+$/, "") !== match[1].replace(/=+$/, "")
  )
    throw new Error("Invalid or oversized JPEG derivative.");
  return [
    { text: `Photo ID: ${photo.id}; area: ${photo.area}.` },
    { image: { format: "jpeg", source: { bytes } } },
  ];
}

export type BedrockStructuredRequest<T> = {
  modelId: string;
  instructions: string;
  content: readonly ContentBlock[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

/**
 * Nova's forced tool schema is supported independently of Bedrock's newer
 * outputConfig/strict structured-output feature. The tool is only an output
 * envelope: nothing is executed, and local validation remains mandatory.
 *
 * https://docs.aws.amazon.com/nova/latest/nova2-userguide/advanced-prompting-techniques.html
 * The caller must also run report-specific evidence/translation-slot validation.
 */
export async function bedrockStructuredOutput<T>(
  request: BedrockStructuredRequest<T>,
  client: BedrockConverseClient,
): Promise<T> {
  if (
    !request.modelId.trim() ||
    !request.instructions.trim() ||
    !request.content.length ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName) ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxOutputTokens > 12_000
  )
    throw new Error("Invalid Bedrock request configuration.");

  const jsonSchema = z.toJSONSchema(request.schema, { target: "draft-7" });
  // The version marker is unnecessary in a tool input schema. Keep every
  // application constraint for the provider and validate them again locally.
  delete jsonSchema.$schema;
  if (jsonSchema.type !== "object")
    throw new Error("Bedrock structured output requires an object schema.");

  const timeout = AbortSignal.timeout(90_000);
  const abortSignal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
  abortSignal.throwIfAborted();

  const response = await client.send(
    new ConverseCommand({
      modelId: request.modelId,
      system: [{ text: request.instructions }],
      messages: [{ role: "user", content: [...request.content] }],
      inferenceConfig: {
        maxTokens: request.maxOutputTokens,
        temperature: 0,
      },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: request.schemaName,
              description: "Return the requested JSON result using this schema.",
              inputSchema: {
                json: jsonSchema as NonNullable<ToolInputSchema["json"]>,
              },
            },
          },
        ],
        toolChoice: { tool: { name: request.schemaName } },
      },
    }),
    { abortSignal },
  );
  abortSignal.throwIfAborted();

  const message = response.output?.message;
  const calls = message?.content?.flatMap((block) =>
    block.toolUse ? [block.toolUse] : [],
  );
  if (
    response.stopReason !== "tool_use" ||
    message?.role !== "assistant" ||
    calls?.length !== 1 ||
    calls[0].name !== request.schemaName ||
    !calls[0].toolUseId
  )
    throw new Error(
      "The AI returned an incomplete or unsupported response. Original evidence is preserved.",
    );

  const parsed = request.schema.safeParse(calls[0].input);
  if (!parsed.success)
    throw new Error(
      "The AI response could not be validated. Original evidence is preserved.",
    );
  return parsed.data;
}
