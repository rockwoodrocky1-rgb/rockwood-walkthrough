import CloudGate from "../src/CloudGate";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { liveEnabled } from "../server/api";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // Existing report links continue to open their original database. The Cam
  // entry point now uses the workspace's accounts, properties and evidence.
  if (process.env.WORKSPACE_CAM_ENABLED === "true" && !query.report && query.legacy !== "1")
    redirect("https://rockwood-projects.vercel.app/cam");
  return (
    <CloudGate
      initialLiveAiEnabled={liveEnabled()}
      logoAvailable={existsSync(
        join(process.cwd(), "public/brand/rockwood-logo.png"),
      )}
    />
  );
}
