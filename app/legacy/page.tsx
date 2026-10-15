import CloudGate from '../../src/CloudGate';
import { liveEnabled } from '../../server/api';
export const dynamic = 'force-dynamic';
export default function LegacyPage() {
  return <CloudGate initialLiveAiEnabled={liveEnabled()} logoAvailable />;
}
