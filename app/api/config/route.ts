import { liveEnabled } from "../../../server/api";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { live: liveEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
