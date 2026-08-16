import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMinecraftProfileReleaseReport } from "../scripts/report-minecraft-profiles";
import {
  EXPECTED_JAVA_RELEASE_ROUTE,
  auditJavaReleaseRoute,
} from "../scripts/minecraft-release-route";

test("release profile report separates tested, pending, best-effort, and missing versions", () => {
  const report = createMinecraftProfileReleaseReport(["1.7.10", "1.20.1", "26.3", "future-test"]);

  assert.deepEqual(report.verified, ["1.20.1"]);
  assert.deepEqual(report.provisional, ["26.3"]);
  assert.ok(report.untested.includes("1.7.10"));
  assert.ok(report.bestEffort.includes("1.7.10"));
  assert.ok(report.attemptable.includes("1.7.10"));
  assert.deepEqual(report.missing, ["future-test"]);
  assert.deepEqual(report.issues, []);
  const verified = report.profiles.find(({ id }) => id === "1.20.1");
  assert.equal(verified?.dataVersion, 3465);
  assert.equal(verified?.datapackFormat?.packFormat, 15);
  assert.equal(verified?.blockStateAdapter, "java_namespaced_1_20_1");
  assert.deepEqual(verified?.defaultDimension, { minY: -64, height: 384 });
  assert.equal(verified?.exporters.litematic?.adapter, "litematica_v6");
  assert.equal(verified?.exporters.spongeSchematic?.formatVersion, 3);
  assert.match(verified?.verification?.source ?? "", /Mojang 1\.20\.1/);
  assert.equal(verified?.verification?.verifiedAt, "2026-08-16");
  assert.equal(verified?.maximumVerifiedHeight, null);
  assert.equal(verified?.extendedHeightVerification, null);
  const provisional = report.profiles.find(({ id }) => id === "26.3");
  assert.equal(provisional?.exporters.litematic, null);
  assert.deepEqual(provisional?.compatibility, {
    serializerProfileId: "1.20.1",
    level: "best_effort",
    warningCode: "JAVA_VERSION_BEST_EFFORT",
  });
  assert.equal(provisional?.availableForAttempt, true);
  assert.equal(provisional?.effectiveSerializer?.profileId, "1.20.1");
  assert.equal(provisional?.effectiveSerializer?.dataVersion, 3465);
});

test("locked release route detects a missing or reordered registry entry", () => {
  assert.equal(EXPECTED_JAVA_RELEASE_ROUTE.length, 76);
  const withoutOne = EXPECTED_JAVA_RELEASE_ROUTE.filter((id) => id !== "1.20.4");
  const missing = auditJavaReleaseRoute(withoutOne);
  assert.deepEqual(missing.missing, ["1.20.4"]);
  assert.equal(missing.orderMatches, false);

  const reordered = [...EXPECTED_JAVA_RELEASE_ROUTE];
  [reordered[10], reordered[11]] = [reordered[11], reordered[10]];
  const order = auditJavaReleaseRoute(reordered);
  assert.deepEqual(order.missing, []);
  assert.deepEqual(order.unexpected, []);
  assert.equal(order.orderMatches, false);
});

test("profile report CLI emits machine-readable JSON without modifying the workspace", () => {
  const report = createMinecraftProfileReleaseReport();
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.registered, report.profiles.length);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.routeAudit, {
    expected: 76,
    registered: 76,
    missing: [],
    unexpected: [],
    orderMatches: true,
  });
  assert.deepEqual(report.issues, []);
  assert.equal(report.attemptable.length, report.registered);

  const cli = readFileSync("scripts/report-minecraft-profiles.mjs", "utf8");
  assert.match(cli, /createMinecraftProfileReleaseReport/);
  assert.match(cli, /JSON\.stringify\(report, null, 2\)/);
  assert.match(cli, /process\.exitCode = 1/);
  assert.match(cli, /routeAudit\.orderMatches/);
  assert.doesNotMatch(cli, /writeFile|appendFile|mkdir/);
});
