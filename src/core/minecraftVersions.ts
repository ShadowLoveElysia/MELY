/** unavailable 仅保留给旧持久化数据；当前登记 Profile 使用 untested 表示未测试。 */
export type JavaReleaseStatus = "verified" | "provisional" | "untested" | "unavailable";
export type JavaHeightCapability = "default_only" | "third_party_extended";
export type JavaHeightEra = "legacy_fixed" | "modern_datapack" | "unknown";
export type JavaExporterFormat = "litematic" | "spongeSchematic" | "legacySchematic";
export type JavaCompatibilityLevel = "exact" | "best_effort";
export type JavaCompatibilityWarningCode = "JAVA_VERSION_BEST_EFFORT";

export interface DataPackFormatDescriptor {
  readonly packFormat: number;
  readonly adapter: string;
}

export interface JavaDimensionDescriptor {
  readonly minY: number;
  readonly height: number;
}

export interface JavaExporterDescriptor {
  readonly adapter: string;
  readonly formatVersion: number;
  readonly subVersion: number | null;
  readonly fixture: string;
}

export interface JavaVersionExporters {
  readonly litematic: JavaExporterDescriptor | null;
  readonly spongeSchematic: JavaExporterDescriptor | null;
  readonly legacySchematic: JavaExporterDescriptor | null;
}

export interface JavaVersionVerification {
  readonly source: string;
  readonly fixture: string;
  readonly verifiedAt: string;
}

export interface JavaVersionCompatibility {
  /** 精确元数据缺失时，明确指向实际用于写出的已知 Serializer Profile。 */
  readonly serializerProfileId: string;
  readonly level: JavaCompatibilityLevel;
  readonly warningCode: JavaCompatibilityWarningCode | null;
}

export interface JavaVersionProfile {
  readonly id: string;
  readonly label: string;
  readonly releaseOrder: number;
  readonly releaseStatus: JavaReleaseStatus;
  readonly releasedAt: string | null;
  readonly releaseSource: string;
  readonly dataVersion: number | null;
  readonly datapackFormat: DataPackFormatDescriptor | null;
  readonly blockStateAdapter: string | null;
  readonly defaultDimension: JavaDimensionDescriptor | null;
  readonly heightEra: JavaHeightEra;
  readonly heightCapability: JavaHeightCapability;
  /** 仅表示已经完成外部世界和目标工具验证的扩展高度上限。 */
  readonly maximumVerifiedHeight: number | null;
  readonly extendedHeightVerification: JavaVersionVerification | null;
  readonly blocks: {
    /** null 表示还未核对，不等同于确认不存在。 */
    readonly whiteStainedGlassPane: boolean | null;
    readonly endRod: boolean | null;
  };
  readonly exporters: JavaVersionExporters;
  readonly verification: JavaVersionVerification | null;
  /** 可尝试生成与测试状态分离；best_effort 必须向用户显示兼容性警告。 */
  readonly compatibility: JavaVersionCompatibility;
}

/**
 * 保留旧导出器依赖的类型和字段；新代码应从 exporters 查询格式能力。
 */
export interface MinecraftVersionProfile extends JavaVersionProfile {
  readonly dataVersion: number;
  readonly blockStateAdapter: string;
  readonly defaultDimension: JavaDimensionDescriptor;
  readonly litematicVersion: number;
  readonly litematicSubVersion: number;
  readonly exporters: JavaVersionExporters & {
    readonly litematic: JavaExporterDescriptor;
  };
}

export interface BedrockVersionProfile {
  id: string;
  label: string;
  minEngineVersion: readonly [number, number, number];
  blockVersion: number;
}

export interface JavaVersionProfileReport {
  readonly total: number;
  readonly verified: readonly string[];
  readonly provisional: readonly string[];
  readonly untested: readonly string[];
  readonly bestEffort: readonly string[];
  readonly attemptable: readonly string[];
  readonly issues: readonly string[];
}

export interface JavaCompatibilityProfileResolution {
  readonly requestedProfile: JavaVersionProfile;
  /** Serializer 真正使用的 Profile，可能与用户选择的版本不同。 */
  readonly serializerProfile: MinecraftVersionProfile;
  readonly effectiveDefaultDimension: JavaDimensionDescriptor;
  readonly level: JavaCompatibilityLevel;
  readonly warningCode: JavaCompatibilityWarningCode | null;
}

export interface JavaExporterCapabilityResolution extends JavaCompatibilityProfileResolution {
  readonly format: JavaExporterFormat;
  readonly descriptor: JavaExporterDescriptor;
}

const MOJANG_VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

// 正式版清单来自 Mojang version_manifest_v2，顺序固定后不再通过版本字符串推断能力。
const RELEASES = [
  ["1.7.10", "2014-05-14"],
  ["1.8", "2014-09-02"],
  ["1.8.1", "2014-11-24"],
  ["1.8.2", "2015-02-19"],
  ["1.8.3", "2015-02-20"],
  ["1.8.4", "2015-04-17"],
  ["1.8.5", "2015-05-22"],
  ["1.8.6", "2015-05-25"],
  ["1.8.7", "2015-06-05"],
  ["1.8.8", "2015-07-27"],
  ["1.8.9", "2015-12-03"],
  ["1.9", "2016-02-29"],
  ["1.9.1", "2016-03-30"],
  ["1.9.2", "2016-03-30"],
  ["1.9.3", "2016-05-10"],
  ["1.9.4", "2016-05-10"],
  ["1.10", "2016-06-08"],
  ["1.10.1", "2016-06-22"],
  ["1.10.2", "2016-06-23"],
  ["1.11", "2016-11-14"],
  ["1.11.1", "2016-12-20"],
  ["1.11.2", "2016-12-21"],
  ["1.12", "2017-06-02"],
  ["1.12.1", "2017-08-03"],
  ["1.12.2", "2017-09-18"],
  ["1.13", "2018-07-18"],
  ["1.13.1", "2018-08-22"],
  ["1.13.2", "2018-10-22"],
  ["1.14", "2019-04-23"],
  ["1.14.1", "2019-05-13"],
  ["1.14.2", "2019-05-27"],
  ["1.14.3", "2019-06-24"],
  ["1.14.4", "2019-07-19"],
  ["1.15", "2019-12-09"],
  ["1.15.1", "2019-12-16"],
  ["1.15.2", "2020-01-17"],
  ["1.16", "2020-06-23"],
  ["1.16.1", "2020-06-24"],
  ["1.16.2", "2020-08-11"],
  ["1.16.3", "2020-09-10"],
  ["1.16.4", "2020-10-29"],
  ["1.16.5", "2021-01-14"],
  ["1.17", "2021-06-08"],
  ["1.17.1", "2021-07-06"],
  ["1.18", "2021-11-30"],
  ["1.18.1", "2021-12-10"],
  ["1.18.2", "2022-02-28"],
  ["1.19", "2022-06-07"],
  ["1.19.1", "2022-07-27"],
  ["1.19.2", "2022-08-05"],
  ["1.19.3", "2022-12-07"],
  ["1.19.4", "2023-03-14"],
  ["1.20", "2023-06-02"],
  ["1.20.1", "2023-06-12"],
  ["1.20.2", "2023-09-20"],
  ["1.20.3", "2023-12-04"],
  ["1.20.4", "2023-12-07"],
  ["1.20.5", "2024-04-23"],
  ["1.20.6", "2024-04-29"],
  ["1.21", "2024-06-13"],
  ["1.21.1", "2024-08-08"],
  ["1.21.2", "2024-10-22"],
  ["1.21.3", "2024-10-23"],
  ["1.21.4", "2024-12-03"],
  ["1.21.5", "2025-03-25"],
  ["1.21.6", "2025-06-17"],
  ["1.21.7", "2025-06-30"],
  ["1.21.8", "2025-07-17"],
  ["1.21.9", "2025-09-30"],
  ["1.21.10", "2025-10-07"],
  ["1.21.11", "2025-12-09"],
  ["26.1", "2026-03-24"],
  ["26.1.1", "2026-04-01"],
  ["26.1.2", "2026-04-09"],
  ["26.2", "2026-06-16"],
] as const;

const LEGACY_FIXED_IDS = new Set<string>([
  "1.7.10",
  "1.8", "1.8.1", "1.8.2", "1.8.3", "1.8.4", "1.8.5", "1.8.6", "1.8.7", "1.8.8", "1.8.9",
  "1.9", "1.9.1", "1.9.2", "1.9.3", "1.9.4",
  "1.10", "1.10.1", "1.10.2",
  "1.11", "1.11.1", "1.11.2",
  "1.12", "1.12.1", "1.12.2",
  "1.13", "1.13.1", "1.13.2",
  "1.14", "1.14.1", "1.14.2", "1.14.3", "1.14.4",
  "1.15", "1.15.1", "1.15.2",
  "1.16", "1.16.1", "1.16.2", "1.16.3", "1.16.4", "1.16.5",
]);

const PRE_END_ROD_IDS = new Set<string>([
  "1.7.10",
  "1.8", "1.8.1", "1.8.2", "1.8.3", "1.8.4", "1.8.5", "1.8.6", "1.8.7", "1.8.8", "1.8.9",
]);

const KNOWN_256_DIMENSION_IDS = new Set<string>([
  ...LEGACY_FIXED_IDS,
  "1.17", "1.17.1",
]);

const KNOWN_384_DIMENSION_IDS = new Set<string>([
  "1.18", "1.18.1", "1.18.2",
  "1.19", "1.19.1", "1.19.2", "1.19.3", "1.19.4",
  "1.20", "1.20.1",
]);

const NO_EXPORTERS: JavaVersionExporters = Object.freeze({
  litematic: null,
  spongeSchematic: null,
  legacySchematic: null,
});

const defaultDimensionFor = (id: string): JavaDimensionDescriptor | null => {
  if (KNOWN_256_DIMENSION_IDS.has(id)) return Object.freeze({ minY: 0, height: 256 });
  if (KNOWN_384_DIMENSION_IDS.has(id)) return Object.freeze({ minY: -64, height: 384 });
  return null;
};

const releaseOrderOf = (id: string) => {
  const index = RELEASES.findIndex(([releaseId]) => releaseId === id);
  if (index < 0) throw new Error(`Missing release order for Java ${id}`);
  return index + 1;
};

const verifiedLitematic: JavaExporterDescriptor = Object.freeze({
  adapter: "litematica_v6",
  formatVersion: 6,
  subVersion: 1,
  fixture: "tests/litematic.test.ts",
});

export const MINECRAFT_1_20_1: MinecraftVersionProfile = Object.freeze({
  id: "1.20.1",
  label: "Minecraft Java 1.20.1",
  releaseOrder: releaseOrderOf("1.20.1"),
  releaseStatus: "verified",
  releasedAt: "2023-06-12",
  releaseSource: MOJANG_VERSION_MANIFEST,
  dataVersion: 3465,
  datapackFormat: Object.freeze({ packFormat: 15, adapter: "java_1_20_1_dimension_codec" }),
  blockStateAdapter: "java_namespaced_1_20_1",
  defaultDimension: Object.freeze({ minY: -64, height: 384 }),
  heightEra: "modern_datapack",
  heightCapability: "third_party_extended",
  // 当前只验证了默认 384 层与序列化格式，第三方超限世界仍保持关闭。
  maximumVerifiedHeight: null,
  extendedHeightVerification: null,
  blocks: Object.freeze({ whiteStainedGlassPane: true, endRod: true }),
  exporters: Object.freeze({
    litematic: verifiedLitematic,
    spongeSchematic: Object.freeze({
      adapter: "sponge_schematic_v3",
      formatVersion: 3,
      subVersion: null,
      fixture: "tests/schematic.test.ts",
    }),
    legacySchematic: null,
  }),
  verification: Object.freeze({
    source: "Mojang 1.20.1 server.jar version.json (SHA-1 84194a2f286ef7c14ed7ce0090dba59902951553) and repository serializer audits",
    fixture: "tests/litematic.test.ts; tests/schematic.test.ts",
    verifiedAt: "2026-08-16",
  }),
  compatibility: Object.freeze({
    serializerProfileId: "1.20.1",
    level: "exact",
    warningCode: null,
  }),
  litematicVersion: verifiedLitematic.formatVersion,
  litematicSubVersion: verifiedLitematic.subVersion ?? 0,
});

const untestedProfile = (
  id: string,
  releasedAt: string,
  releaseOrder: number,
): JavaVersionProfile => {
  const legacyFixed = LEGACY_FIXED_IDS.has(id);
  return Object.freeze({
    id,
    label: `Minecraft Java ${id}`,
    releaseOrder,
    releaseStatus: "untested",
    releasedAt,
    releaseSource: MOJANG_VERSION_MANIFEST,
    dataVersion: null,
    datapackFormat: null,
    blockStateAdapter: null,
    defaultDimension: defaultDimensionFor(id),
    heightEra: legacyFixed ? "legacy_fixed" : "modern_datapack",
    heightCapability: legacyFixed ? "default_only" : "third_party_extended",
    maximumVerifiedHeight: null,
    extendedHeightVerification: null,
    blocks: Object.freeze({
      whiteStainedGlassPane: true,
      endRod: !PRE_END_ROD_IDS.has(id),
    }),
    exporters: NO_EXPORTERS,
    verification: null,
    compatibility: Object.freeze({
      serializerProfileId: MINECRAFT_1_20_1.id,
      level: "best_effort",
      warningCode: "JAVA_VERSION_BEST_EFFORT",
    }),
  });
};

const TARGET_26_3: JavaVersionProfile = Object.freeze({
  id: "26.3",
  label: "Minecraft Java 26.3 (待正式发布验证)",
  releaseOrder: RELEASES.length + 1,
  releaseStatus: "provisional",
  releasedAt: null,
  releaseSource: MOJANG_VERSION_MANIFEST,
  dataVersion: null,
  datapackFormat: null,
  blockStateAdapter: null,
  defaultDimension: null,
  heightEra: "unknown",
  heightCapability: "default_only",
  maximumVerifiedHeight: null,
  extendedHeightVerification: null,
  blocks: Object.freeze({ whiteStainedGlassPane: null, endRod: null }),
  exporters: NO_EXPORTERS,
  verification: null,
  compatibility: Object.freeze({
    serializerProfileId: MINECRAFT_1_20_1.id,
    level: "best_effort",
    warningCode: "JAVA_VERSION_BEST_EFFORT",
  }),
});

export const JAVA_VERSION_PROFILES: readonly JavaVersionProfile[] = Object.freeze([
  ...RELEASES.map(([id, releasedAt], index) => id === MINECRAFT_1_20_1.id
    ? MINECRAFT_1_20_1
    : untestedProfile(id, releasedAt, index + 1)),
  TARGET_26_3,
]);

export const JAVA_VERSION_IDS: readonly string[] = Object.freeze(
  JAVA_VERSION_PROFILES.map(({ id }) => id),
);

const PROFILE_REGISTRY = new Map(JAVA_VERSION_PROFILES.map((profile) => [profile.id, profile]));

export const getJavaVersionProfile = (id: string): JavaVersionProfile | null =>
  PROFILE_REGISTRY.get(id) ?? null;

export const requireJavaVersionProfile = (id: string): JavaVersionProfile => {
  const profile = getJavaVersionProfile(id);
  if (!profile) throw new RangeError(`JAVA_VERSION_PROFILE_UNKNOWN: No Java version profile for ${id}`);
  return profile;
};

export const requireVerifiedJavaVersionProfile = (id: string): JavaVersionProfile => {
  const profile = requireJavaVersionProfile(id);
  if (profile.releaseStatus !== "verified" || !profile.verification) {
    throw new RangeError(`JAVA_VERSION_PROFILE_UNVERIFIED: Java ${id} is not verified for export`);
  }
  return profile;
};

export const isJavaVersionVerified = (id: string) =>
  getJavaVersionProfile(id)?.releaseStatus === "verified";

const isSerializerProfile = (profile: JavaVersionProfile): profile is MinecraftVersionProfile =>
  profile.dataVersion !== null
  && profile.blockStateAdapter !== null
  && profile.defaultDimension !== null
  && profile.exporters.litematic !== null;

/**
 * 解析生成/导出所用的实际 Serializer Profile。返回 best_effort 时，
 * 调用方必须告知用户产物使用了回退元数据，不得宣称精确支持目标版本。
 */
export const getJavaCompatibilityProfile = (
  id: string,
): JavaCompatibilityProfileResolution | null => {
  const requestedProfile = getJavaVersionProfile(id);
  if (!requestedProfile) return null;
  const serializerProfile = getJavaVersionProfile(
    requestedProfile.compatibility.serializerProfileId,
  );
  if (!serializerProfile || !isSerializerProfile(serializerProfile)) return null;
  return Object.freeze({
    requestedProfile,
    serializerProfile,
    effectiveDefaultDimension: requestedProfile.defaultDimension
      ?? serializerProfile.defaultDimension,
    level: requestedProfile.compatibility.level,
    warningCode: requestedProfile.compatibility.warningCode,
  });
};

export const requireJavaCompatibilityProfile = (
  id: string,
): JavaCompatibilityProfileResolution => {
  const resolution = getJavaCompatibilityProfile(id);
  if (!resolution) {
    throw new RangeError(`JAVA_VERSION_PROFILE_UNKNOWN: No compatible Java serializer for ${id}`);
  }
  return resolution;
};

export const resolveJavaExporterCapability = (
  id: string,
  format: JavaExporterFormat,
): JavaExporterCapabilityResolution | null => {
  const resolution = getJavaCompatibilityProfile(id);
  if (!resolution) return null;
  const descriptor = resolution.serializerProfile.exporters[format];
  if (!descriptor) return null;
  return Object.freeze({ ...resolution, format, descriptor });
};

export const getJavaExporterCapability = (
  id: string,
  format: JavaExporterFormat,
): JavaExporterDescriptor | null => resolveJavaExporterCapability(id, format)?.descriptor ?? null;

export const isJavaExporterAvailable = (id: string, format: JavaExporterFormat) =>
  getJavaExporterCapability(id, format) !== null;

export const isJavaGenerationAvailable = (id: string) =>
  getJavaCompatibilityProfile(id) !== null;

export const getJavaEffectiveDefaultDimension = (
  id: string,
): JavaDimensionDescriptor | null => getJavaCompatibilityProfile(id)?.effectiveDefaultDimension ?? null;

export const validateJavaVersionProfiles = (
  profiles: readonly JavaVersionProfile[] = JAVA_VERSION_PROFILES,
): readonly string[] => {
  const issues: string[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();

  profiles.forEach((profile, index) => {
    if (!profile.id || ids.has(profile.id)) issues.push(`Duplicate or empty Java version id: ${profile.id}`);
    ids.add(profile.id);
    if (!Number.isSafeInteger(profile.releaseOrder) || profile.releaseOrder <= 0
      || orders.has(profile.releaseOrder)) {
      issues.push(`Invalid or duplicate releaseOrder for Java ${profile.id}`);
    }
    orders.add(profile.releaseOrder);
    if (index > 0 && profile.releaseOrder <= profiles[index - 1].releaseOrder) {
      issues.push(`Java ${profile.id} is not in releaseOrder sequence`);
    }
    if (profile.defaultDimension && (
      !Number.isSafeInteger(profile.defaultDimension.minY)
      || !Number.isSafeInteger(profile.defaultDimension.height)
      || profile.defaultDimension.height <= 0
    )) {
      issues.push(`Invalid default dimension for Java ${profile.id}`);
    }

    const availableExporters = Object.values(profile.exporters).filter(Boolean);
    if (profile.releaseStatus === "verified") {
      if (profile.dataVersion === null
        || !profile.datapackFormat
        || !profile.blockStateAdapter
        || !profile.defaultDimension
        || !profile.verification
        || availableExporters.length === 0) {
        issues.push(`Verified Java ${profile.id} has incomplete capabilities`);
      }
    }

    const compatibility = profile.compatibility;
    const serializerProfile = profiles.find(({ id }) => id === compatibility.serializerProfileId);
    if (!serializerProfile
      || serializerProfile.dataVersion === null
      || serializerProfile.exporters.litematic === null) {
      issues.push(`Java ${profile.id} references an invalid compatibility serializer profile`);
    }
    if (profile.releaseStatus === "verified") {
      if (
        compatibility.level !== "exact"
        || compatibility.serializerProfileId !== profile.id
        || compatibility.warningCode !== null
      ) {
        issues.push(`Verified Java ${profile.id} has invalid native compatibility metadata`);
      }
    } else if (
      compatibility.level !== "best_effort"
      || compatibility.warningCode !== "JAVA_VERSION_BEST_EFFORT"
    ) {
      issues.push(`Untested Java ${profile.id} must expose a best-effort warning`);
    }

    const extendedVerification = profile.extendedHeightVerification;
    const maximumExtendedHeight = profile.maximumVerifiedHeight;
    if (profile.heightCapability === "default_only"
      && (maximumExtendedHeight !== null || extendedVerification !== null)) {
      issues.push(`Default-only Java ${profile.id} exposes extended-height verification`);
    }
    if ((maximumExtendedHeight === null) !== (extendedVerification === null)) {
      issues.push(`Java ${profile.id} has inconsistent extended-height verification evidence`);
    }
    if (maximumExtendedHeight !== null) {
      if (
        profile.heightCapability !== "third_party_extended"
        || !profile.defaultDimension
        || !Number.isSafeInteger(maximumExtendedHeight)
        || maximumExtendedHeight <= profile.defaultDimension.height
      ) {
        issues.push(`Java ${profile.id} has an invalid verified extended-height limit`);
      }
    }
  });
  return issues;
};

export const assertJavaVersionProfiles = (
  profiles: readonly JavaVersionProfile[] = JAVA_VERSION_PROFILES,
) => {
  const issues = validateJavaVersionProfiles(profiles);
  if (issues.length > 0) throw new Error(`Invalid Java version profiles:\n${issues.join("\n")}`);
};

export const javaVersionProfileReport = (): JavaVersionProfileReport => ({
  total: JAVA_VERSION_PROFILES.length,
  verified: JAVA_VERSION_PROFILES.filter(({ releaseStatus }) => releaseStatus === "verified")
    .map(({ id }) => id),
  provisional: JAVA_VERSION_PROFILES.filter(({ releaseStatus }) => releaseStatus === "provisional")
    .map(({ id }) => id),
  untested: JAVA_VERSION_PROFILES.filter(({ releaseStatus }) => releaseStatus === "untested")
    .map(({ id }) => id),
  bestEffort: JAVA_VERSION_PROFILES.filter(({ compatibility }) => compatibility.level === "best_effort")
    .map(({ id }) => id),
  attemptable: JAVA_VERSION_PROFILES.filter(({ id }) => getJavaCompatibilityProfile(id) !== null)
    .map(({ id }) => id),
  issues: validateJavaVersionProfiles(),
});

assertJavaVersionProfiles();

export const BEDROCK_1_20_10: BedrockVersionProfile = {
  id: "1.20.10",
  label: "Minecraft Bedrock 1.20.10",
  minEngineVersion: [1, 20, 10],
  blockVersion: 0x0114_0a01,
};

export const DEFAULT_MINECRAFT_VERSION = MINECRAFT_1_20_1;
export const DEFAULT_BEDROCK_VERSION = BEDROCK_1_20_10;
