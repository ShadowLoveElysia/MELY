import {
  JAVA_VERSION_PROFILES,
  getJavaCompatibilityProfile,
  javaVersionProfileReport,
} from "../src/core/minecraftVersions.ts";
import {
  EXPECTED_JAVA_RELEASE_ROUTE,
  auditJavaReleaseRoute,
} from "./minecraft-release-route.ts";

export const createMinecraftProfileReleaseReport = (
  requestedVersionIds: readonly string[] = EXPECTED_JAVA_RELEASE_ROUTE,
) => {
  const report = javaVersionProfileReport();
  const registered = new Set(JAVA_VERSION_PROFILES.map(({ id }) => id));
  const missing = [...new Set(requestedVersionIds)].filter((id) => !registered.has(id));
  const routeAudit = auditJavaReleaseRoute(JAVA_VERSION_PROFILES.map(({ id }) => id));
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    requested: requestedVersionIds.length,
    registered: report.total,
    verified: report.verified,
    provisional: report.provisional,
    untested: report.untested,
    bestEffort: report.bestEffort,
    attemptable: report.attemptable,
    missing,
    routeAudit,
    issues: report.issues,
    profiles: JAVA_VERSION_PROFILES.map((profile) => {
      const resolution = getJavaCompatibilityProfile(profile.id);
      return {
        id: profile.id,
        label: profile.label,
        releaseOrder: profile.releaseOrder,
        releaseStatus: profile.releaseStatus,
        releasedAt: profile.releasedAt,
        releaseSource: profile.releaseSource,
        dataVersion: profile.dataVersion,
        datapackFormat: profile.datapackFormat,
        blockStateAdapter: profile.blockStateAdapter,
        defaultDimension: profile.defaultDimension,
        heightEra: profile.heightEra,
        heightCapability: profile.heightCapability,
        maximumVerifiedHeight: profile.maximumVerifiedHeight,
        extendedHeightVerification: profile.extendedHeightVerification,
        blocks: profile.blocks,
        exporters: profile.exporters,
        verification: profile.verification,
        compatibility: profile.compatibility,
        availableForAttempt: resolution !== null,
        effectiveSerializer: resolution ? {
          profileId: resolution.serializerProfile.id,
          dataVersion: resolution.serializerProfile.dataVersion,
          blockStateAdapter: resolution.serializerProfile.blockStateAdapter,
          defaultDimension: resolution.effectiveDefaultDimension,
          exporters: resolution.serializerProfile.exporters,
        } : null,
      };
    }),
  };
};
