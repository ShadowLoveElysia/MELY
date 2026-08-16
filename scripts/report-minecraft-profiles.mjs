import { createMinecraftProfileReleaseReport } from "./report-minecraft-profiles.ts";

const report = createMinecraftProfileReleaseReport();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (
  report.missing.length > 0
  || report.routeAudit.missing.length > 0
  || report.routeAudit.unexpected.length > 0
  || !report.routeAudit.orderMatches
  || report.issues.length > 0
) process.exitCode = 1;
