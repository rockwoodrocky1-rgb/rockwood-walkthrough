import SharedReport from "../../src/SharedReport";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Rockwood · Shared report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function Page() {
  return <SharedReport />;
}
