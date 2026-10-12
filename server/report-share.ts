import { createHmac, timingSafeEqual } from "node:crypto";
const scope = "rockwood:read-only-visit:v1";
function signature(workspace: string, visit: string, secret: string) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([scope, workspace, visit]))
    .digest("hex");
}
export function shareToken(
  workspace: string,
  visit: string,
  secret = process.env.SUPABASE_SECRET_KEY,
) {
  if (!secret) throw new Error("Report sharing needs the server connection.");
  return signature(workspace, visit, secret);
}
export function validShareToken(
  workspace: string,
  visit: string,
  token: string,
  secret = process.env.SUPABASE_SECRET_KEY,
) {
  if (!secret || !/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(
    Buffer.from(token, "hex"),
    Buffer.from(signature(workspace, visit, secret), "hex"),
  );
}
export function sharedReportLink(
  appUrl: string,
  workspace: string,
  visit: string,
) {
  const url = new URL(appUrl);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("Report links require HTTPS.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("APP_URL must be a plain site origin.");
  url.pathname = "/shared-report";
  url.searchParams.set("workspace", workspace);
  url.searchParams.set("visit", visit);
  url.searchParams.set("token", shareToken(workspace, visit));
  return url.toString();
}
