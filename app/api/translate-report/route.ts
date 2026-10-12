import {
  guard,
  readLimited,
  errorResponse,
  HttpError,
} from "../../../server/api";
import { translateReportContent } from "../../../server/translation";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    await guard(request);
    const bytes = await readLimited(request);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HttpError(400, "Invalid report input.");
    }
    return Response.json(await translateReportContent(input));
  } catch (error) {
    return errorResponse(error);
  }
}
