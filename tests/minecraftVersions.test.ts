import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MINECRAFT_VERSION,
  JAVA_VERSION_IDS,
  JAVA_VERSION_PROFILES,
  getJavaExporterCapability,
  getJavaCompatibilityProfile,
  getJavaEffectiveDefaultDimension,
  getJavaVersionProfile,
  isJavaGenerationAvailable,
  isJavaExporterAvailable,
  javaVersionProfileReport,
  requireJavaVersionProfile,
  requireVerifiedJavaVersionProfile,
  validateJavaVersionProfiles,
} from "../src/core/minecraftVersions";

test("Java profile route covers exact releases and keeps 26.3 provisional", () => {
  assert.equal(JAVA_VERSION_IDS[0], "1.7.10");
  assert.equal(JAVA_VERSION_IDS.at(-1), "26.3");
  assert.ok(JAVA_VERSION_IDS.includes("1.16.5"));
  assert.ok(JAVA_VERSION_IDS.includes("1.17.1"));
  assert.ok(JAVA_VERSION_IDS.includes("1.20.6"));
  assert.ok(JAVA_VERSION_IDS.includes("1.21.11"));
  assert.ok(JAVA_VERSION_IDS.includes("26.2"));
  assert.equal(new Set(JAVA_VERSION_IDS).size, JAVA_VERSION_IDS.length);
  assert.deepEqual(validateJavaVersionProfiles(), []);

  const target = requireJavaVersionProfile("26.3");
  assert.equal(target.releaseStatus, "provisional");
  assert.equal(target.releasedAt, null);
  assert.equal(target.dataVersion, null);
  assert.equal(target.defaultDimension, null);
  assert.equal(target.heightEra, "unknown");
  assert.equal(target.blocks.whiteStainedGlassPane, null);
  assert.equal(target.blocks.endRod, null);
  assert.deepEqual(target.exporters, {
    litematic: null,
    spongeSchematic: null,
    legacySchematic: null,
  });
  assert.deepEqual(target.compatibility, {
    serializerProfileId: "1.20.1",
    level: "best_effort",
    warningCode: "JAVA_VERSION_BEST_EFFORT",
  });
});

test("1.20.1 keeps exact repository-verified capabilities", () => {
  const profile = requireVerifiedJavaVersionProfile("1.20.1");
  assert.equal(profile, DEFAULT_MINECRAFT_VERSION);
  assert.equal(profile.dataVersion, 3465);
  assert.equal(profile.datapackFormat?.packFormat, 15);
  assert.deepEqual(profile.defaultDimension, { minY: -64, height: 384 });
  assert.equal(profile.heightCapability, "third_party_extended");
  assert.equal(profile.maximumVerifiedHeight, null);
  assert.equal(profile.extendedHeightVerification, null);
  assert.equal(profile.exporters.litematic?.formatVersion, 6);
  assert.equal(profile.exporters.litematic?.subVersion, 1);
  assert.equal(profile.exporters.spongeSchematic?.formatVersion, 3);
  assert.equal(isJavaExporterAvailable("1.20.1", "litematic"), true);
  assert.equal(isJavaExporterAvailable("1.20.1", "spongeSchematic"), true);
  assert.equal(isJavaExporterAvailable("1.20.1", "legacySchematic"), false);
});

test("extended height cannot be exposed without separate external evidence", () => {
  const profile = requireVerifiedJavaVersionProfile("1.20.1");
  assert.match(profile.verification?.source ?? "", /serializer audits/);
  assert.doesNotMatch(profile.verification?.fixture ?? "", /2032|height/i);

  const missingEvidence = {
    ...profile,
    maximumVerifiedHeight: 2032,
    extendedHeightVerification: null,
  };
  assert.ok(validateJavaVersionProfiles([missingEvidence]).some((issue) =>
    issue.includes("inconsistent extended-height verification evidence")));

  const evidenceWithoutLimit = {
    ...profile,
    maximumVerifiedHeight: null,
    extendedHeightVerification: {
      source: "synthetic external audit",
      fixture: "synthetic fixture",
      verifiedAt: "2026-08-16",
    },
  };
  assert.ok(validateJavaVersionProfiles([evidenceWithoutLimit]).some((issue) =>
    issue.includes("inconsistent extended-height verification evidence")));
});

test("registered untested versions use explicit best-effort serializer fallback", () => {
  assert.equal(getJavaVersionProfile("1.20.01"), null);
  assert.equal(getJavaExporterCapability("1.16.5", "litematic")?.formatVersion, 6);
  assert.equal(getJavaExporterCapability("26.3", "litematic")?.formatVersion, 6);
  assert.equal(getJavaExporterCapability("1.16.5", "legacySchematic"), null);
  assert.equal(isJavaGenerationAvailable("1.16.5"), true);
  assert.equal(isJavaGenerationAvailable("26.3"), true);
  assert.equal(isJavaGenerationAvailable("future"), false);
  assert.deepEqual(getJavaEffectiveDefaultDimension("26.3"), { minY: -64, height: 384 });

  const historical = getJavaCompatibilityProfile("1.16.5");
  assert.equal(historical?.requestedProfile.id, "1.16.5");
  assert.equal(historical?.serializerProfile.id, "1.20.1");
  assert.equal(historical?.serializerProfile.dataVersion, 3465);
  assert.equal(historical?.level, "best_effort");
  assert.equal(historical?.warningCode, "JAVA_VERSION_BEST_EFFORT");

  assert.throws(() => requireJavaVersionProfile("future"), /JAVA_VERSION_PROFILE_UNKNOWN/);
  assert.throws(
    () => requireVerifiedJavaVersionProfile("1.16.5"),
    /JAVA_VERSION_PROFILE_UNVERIFIED/,
  );
  assert.throws(
    () => requireVerifiedJavaVersionProfile("26.3"),
    /JAVA_VERSION_PROFILE_UNVERIFIED/,
  );
});

test("profile report separates verification state from best-effort generation capability", () => {
  const report = javaVersionProfileReport();
  assert.equal(report.total, JAVA_VERSION_PROFILES.length);
  assert.deepEqual(report.verified, ["1.20.1"]);
  assert.deepEqual(report.provisional, ["26.3"]);
  assert.ok(report.untested.includes("1.7.10"));
  assert.ok(report.untested.includes("26.2"));
  assert.equal(report.bestEffort.length, JAVA_VERSION_PROFILES.length - 1);
  assert.deepEqual(report.attemptable, JAVA_VERSION_IDS);
  assert.deepEqual(report.issues, []);
});
