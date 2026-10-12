const key = "rockwood-pending-report-v1";
export function reportTarget(search: string) {
  const query = new URLSearchParams(search),
    report = query.get("report"),
    project = query.get("project");
  return report && project && report.length <= 100 && project.length <= 100
    ? { report, project }
    : null;
}
export function rememberReportLink() {
  const target = reportTarget(location.search);
  if (target)
    localStorage.setItem(
      key,
      JSON.stringify({ ...target, expires: Date.now() + 3_600_000 }),
    );
}
export function restoreReportLink() {
  const target = reportTarget(location.search);
  const saved = localStorage.getItem(key);
  localStorage.removeItem(key);
  if (target) return target;
  try {
    const value = JSON.parse(saved || "null");
    return value?.expires > Date.now() &&
      typeof value.report === "string" &&
      typeof value.project === "string"
      ? reportTarget(
          new URLSearchParams({
            report: value.report,
            project: value.project,
          }).toString(),
        )
      : null;
  } catch {
    return null;
  }
}
