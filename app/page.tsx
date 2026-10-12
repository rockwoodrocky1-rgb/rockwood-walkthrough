import CloudGate from "../src/CloudGate";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { liveEnabled } from "../server/api";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <CloudGate
      initialLiveAiEnabled={liveEnabled()}
      logoAvailable={existsSync(
        join(process.cwd(), "public/brand/rockwood-logo.png"),
      )}
    />
  );
}
