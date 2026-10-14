import { liveEnabled } from "../../../server/api";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { live: liveEnabled(), processing: process.env.AI_PROVIDER === "aws" ? "background" : "request" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
