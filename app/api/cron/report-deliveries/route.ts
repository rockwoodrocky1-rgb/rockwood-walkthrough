import { timingSafeEqual } from "node:crypto";
import { deliveryError, processDelivery } from "../../../../server/delivery";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const received = request.headers.get("authorization") || "";
  const wanted = `Bearer ${expected}`;
  const actual = Buffer.from(received),
    required = Buffer.from(wanted);
  if (
    !expected ||
    actual.length !== required.length ||
    !timingSafeEqual(actual, required)
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Bounded batch: subsequent cron runs drain the persistent queue.
    const deadline = Date.now() + 110_000;
    let processed = 0;
    while (processed < 3 && Date.now() < deadline) {
      const result = await processDelivery();
      if (!result.configured)
        return Response.json({ configured: false }, { status: 503 });
      if (!result.processed) break;
      processed++;
    }
    return Response.json({ processed });
  } catch (error) {
    return deliveryError(error);
  }
}
