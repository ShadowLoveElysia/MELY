import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { AppError, appError } from "./appError";
import type { LoadedMmdModel } from "./mmdModel";
import { normalizeMelyBoneName } from "./melyPose";

const MAX_ARCHIVE_FILES = 5000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_COMPRESSED_ARCHIVE_BYTES = 512 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  bmp: "image/bmp",
  dds: "image/vnd-ms.dds",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pmd: "application/octet-stream",
  pmx: "application/octet-stream",
  png: "image/png",
  tga: "image/x-tga",
  vmd: "application/octet-stream",
  webp: "image/webp",
};

export const normalizeAssetPath = (path: string) =>
  path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "");

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

const withRelativePath = (file: File, relativePath: string) => {
  const normalized = normalizeAssetPath(relativePath);
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: normalized,
  });
  return file;
};

const archiveFile = (path: string, chunks: readonly Uint8Array[]) => {
  const normalized = normalizeAssetPath(path);
  const filename = normalized.split("/").pop() || normalized;
  const type = MIME_TYPES[extensionOf(filename)] || "application/octet-stream";
  const parts: BlobPart[] = chunks.map((chunk) => (
    chunk.buffer instanceof ArrayBuffer
      ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Uint8Array.from(chunk)
  ));
  return withRelativePath(new File(parts, filename, { type }), normalized);
};

const unzipFile = async (archive: File) => {
  if (archive.size > MAX_COMPRESSED_ARCHIVE_BYTES) {
    throw appError("error.archive.tooLarge", { limit: 1 });
  }
  const expanded: File[] = [];
  let fileCount = 0;
  let declaredBytes = 0;
  let expandedBytes = 0;
  let failure: unknown;

  const fail = (error: unknown, file?: UnzipFile) => {
    if (failure) return;
    failure = error;
    file?.terminate?.();
  };
  const unzipper = new Unzip((file) => {
    if (failure) return;
    if (file.name.endsWith("/")) {
      file.ondata = () => {};
      file.start();
      return;
    }
    fileCount += 1;
    if (fileCount > MAX_ARCHIVE_FILES) {
      fail(appError("error.archive.tooManyFiles", { limit: MAX_ARCHIVE_FILES }), file);
      return;
    }
    if ((file.originalSize ?? 0) > MAX_ARCHIVE_ENTRY_BYTES) {
      fail(appError("error.archive.tooLarge", { limit: 1 }), file);
      return;
    }
    declaredBytes += file.originalSize ?? 0;
    if (declaredBytes > MAX_ARCHIVE_BYTES) {
      fail(appError("error.archive.tooLarge", { limit: 1 }), file);
      return;
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) {
        fail(error, file);
        return;
      }
      entryBytes += chunk.byteLength;
      expandedBytes += chunk.byteLength;
      if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES || expandedBytes > MAX_ARCHIVE_BYTES) {
        fail(appError("error.archive.tooLarge", { limit: 1 }), file);
        return;
      }
      if (chunk.byteLength > 0) chunks.push(chunk);
      if (final) expanded.push(archiveFile(file.name, chunks));
    };
    try {
      file.start();
    } catch (error) {
      fail(error, file);
    }
  });
  unzipper.register(UnzipInflate);

  const reader = archive.stream().getReader();
  try {
    while (true) {
      if (failure) throw failure;
      const { value, done } = await reader.read();
      unzipper.push(value ?? new Uint8Array(), done);
      if (failure) throw failure;
      if (done) break;
    }
    return expanded;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw appError("error.archive.invalid", undefined, error);
  } finally {
    reader.releaseLock();
  }
};

export const expandMmdAssets = async (files: readonly File[]) => {
  const expanded: File[] = [];
  for (const file of files) {
    if (extensionOf(file.name) === "zip") {
      expanded.push(...await unzipFile(file));
    } else {
      expanded.push(file);
    }
  }
  return expanded;
};

export const isMmdModelFile = (file: Pick<File, "name">) => /\.(?:pmx|pmd)$/i.test(file.name);
export const isMmdMotionFile = (file: Pick<File, "name">) => /\.vmd$/i.test(file.name);

export interface MmdModelCandidate {
  path: string;
  fileName: string;
  displayName: string;
  format: "pmx" | "pmd";
  size: number;
  vertexCount: number;
  faceCount: number;
  materialCount: number;
  boneCount: number;
  morphCount: number;
  score: number;
}

const ACCESSORY_PATTERN = /(?:accessory|prop|weapon|sword|bow|fan|staff|弓|扇|武器|配件|道具)/i;
const CHARACTER_PATTERN = /(?:character|model|body|dress|skirt|人物|角色|本体|裙|衣)/i;

const candidateScore = (
  file: Pick<File, "name" | "size">,
  counts: Pick<MmdModelCandidate, "vertexCount" | "faceCount" | "materialCount" | "boneCount" | "morphCount">,
) => {
  const complexity = counts.vertexCount * 2
    + counts.faceCount
    + counts.materialCount * 500
    + counts.boneCount * 40
    + counts.morphCount * 2_500
    + file.size * 0.05;
  const accessoryPenalty = ACCESSORY_PATTERN.test(file.name) ? 0.08 : 1;
  const characterBoost = CHARACTER_PATTERN.test(file.name) ? 1.18 : 1;
  return complexity * accessoryPenalty * characterBoost;
};

export const inspectMmdModels = async (files: readonly File[]): Promise<MmdModelCandidate[]> => {
  const models = files.filter(isMmdModelFile);
  if (!models.length) return [];
  const { parsePmdMetadata, parsePmxMetadata } = await import("@yohawing/three-mmd-loader/parser");

  const candidates: MmdModelCandidate[] = [];
  for (const file of models) {
    const path = normalizeAssetPath(file.webkitRelativePath || file.name);
    const format = file.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const metadata = format === "pmd" ? parsePmdMetadata(bytes) : parsePmxMetadata(bytes);
      const counts = {
        vertexCount: metadata.counts.vertices,
        faceCount: metadata.counts.faces,
        materialCount: metadata.counts.materials,
        boneCount: metadata.counts.bones,
        morphCount: metadata.counts.morphs,
      };
      candidates.push({
        path,
        fileName: file.name,
        displayName: file.name.replace(/\.[^.]+$/, "") || metadata.englishName || metadata.name,
        format,
        size: file.size,
        ...counts,
        score: candidateScore(file, counts),
      });
    } catch {
      const counts = {
        vertexCount: 0,
        faceCount: 0,
        materialCount: 0,
        boneCount: 0,
        morphCount: 0,
      };
      candidates.push({
        path,
        fileName: file.name,
        displayName: file.name.replace(/\.[^.]+$/, ""),
        format,
        size: file.size,
        ...counts,
        score: candidateScore(file, counts),
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
};

const chooseShallowestAsset = (files: readonly File[]) => [...files].sort((left, right) => {
  const leftPath = normalizeAssetPath(left.webkitRelativePath || left.name);
  const rightPath = normalizeAssetPath(right.webkitRelativePath || right.name);
  const depthDifference = leftPath.split("/").length - rightPath.split("/").length;
  if (depthDifference !== 0) return depthDifference;
  return leftPath.localeCompare(rightPath, undefined, { numeric: true });
})[0];

export const choosePrimaryMmdModel = (
  files: readonly File[],
  candidates: readonly MmdModelCandidate[] = [],
) => {
  const models = files.filter(isMmdModelFile);
  if (models.length === 0) return undefined;
  const preferred = candidates[0];
  if (preferred) {
    const matched = models.find((file) =>
      normalizeAssetPath(file.webkitRelativePath || file.name) === preferred.path,
    );
    if (matched) return matched;
  }
  return [...models].sort((left, right) => {
    const leftPenalty = ACCESSORY_PATTERN.test(left.name) ? 0.08 : 1;
    const rightPenalty = ACCESSORY_PATTERN.test(right.name) ? 0.08 : 1;
    const scoreDifference = right.size * rightPenalty - left.size * leftPenalty;
    if (scoreDifference !== 0) return scoreDifference;
    return normalizeAssetPath(left.webkitRelativePath || left.name)
      .localeCompare(normalizeAssetPath(right.webkitRelativePath || right.name), undefined, { numeric: true });
  })[0];
};

export const findMmdModelByPath = (files: readonly File[], path: string) => files.find((file) =>
  isMmdModelFile(file)
  && normalizeAssetPath(file.webkitRelativePath || file.name) === normalizeAssetPath(path),
);

export interface MmdMotionCandidate {
  file: File;
  path: string;
  boneTrackCount: number;
  morphTrackCount: number;
  matchedBoneTrackCount: number;
  matchedMorphTrackCount: number;
  maxFrame: number;
}

export type MmdMotionCandidateTracks = Record<
  "dance" | "expression",
  MmdMotionCandidate[]
>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export const selectPrimaryMmdMotionCandidate = (
  candidates: readonly MmdMotionCandidate[],
) => [...candidates].sort((left, right) => {
  const leftTier = left.matchedBoneTrackCount > 0
    ? 3
    : left.matchedMorphTrackCount > 0
      ? 2
      : left.boneTrackCount > 0
        ? 1
        : 0;
  const rightTier = right.matchedBoneTrackCount > 0
    ? 3
    : right.matchedMorphTrackCount > 0
      ? 2
      : right.boneTrackCount > 0
        ? 1
        : 0;
  return rightTier - leftTier
    || right.matchedBoneTrackCount - left.matchedBoneTrackCount
    || right.boneTrackCount - left.boneTrackCount
    || right.maxFrame - left.maxFrame
    || right.matchedMorphTrackCount - left.matchedMorphTrackCount
    || right.morphTrackCount - left.morphTrackCount
    || compareText(left.path, right.path);
})[0];

const sortMotionTrackCandidates = (
  candidates: readonly MmdMotionCandidate[],
  kind: "dance" | "expression",
) => [...candidates]
  .filter((candidate) => kind === "dance"
    ? candidate.matchedBoneTrackCount > 0
    : candidate.matchedMorphTrackCount > 0)
  .sort((left, right) => {
    const matchedDifference = kind === "dance"
      ? right.matchedBoneTrackCount - left.matchedBoneTrackCount
      : right.matchedMorphTrackCount - left.matchedMorphTrackCount;
    const totalDifference = kind === "dance"
      ? right.boneTrackCount - left.boneTrackCount
      : right.morphTrackCount - left.morphTrackCount;
    return matchedDifference
      || totalDifference
      || right.maxFrame - left.maxFrame
      || compareText(left.path, right.path);
  });

export const groupMmdMotionTrackCandidates = (
  candidates: readonly MmdMotionCandidate[],
): MmdMotionCandidateTracks => ({
  dance: sortMotionTrackCandidates(candidates, "dance"),
  expression: sortMotionTrackCandidates(candidates, "expression"),
});

export const selectMmdMotionTrackCandidates = (
  candidates: readonly MmdMotionCandidate[],
) => ({
  dance: sortMotionTrackCandidates(candidates, "dance")[0],
  expression: sortMotionTrackCandidates(candidates, "expression")[0],
});

const motionTargetNames = (model: Pick<LoadedMmdModel, "bones" | "morphNames"> | undefined) => {
  const bones = new Set<string>();
  const morphs = new Set<string>();
  (model?.morphNames ?? []).forEach((name) => {
    const normalized = normalizeMelyBoneName(name);
    if (normalized) morphs.add(normalized);
  });
  model?.bones.forEach((bone) => {
    [bone.name, bone.englishName].forEach((name) => {
      const normalized = normalizeMelyBoneName(name);
      if (normalized) bones.add(normalized);
    });
  });
  return {
    bones,
    morphs,
  };
};

export const choosePrimaryMmdMotion = async (
  files: readonly File[],
  model?: Pick<LoadedMmdModel, "bones" | "morphNames">,
) => {
  const motions = files.filter(isMmdMotionFile);
  if (!motions.length) return undefined;
  const candidates = await inspectMmdMotionCandidates(files, model);
  return selectPrimaryMmdMotionCandidate(candidates)?.file ?? chooseShallowestAsset(motions);
};

export const inspectMmdMotionCandidates = async (
  files: readonly File[],
  model?: Pick<LoadedMmdModel, "bones" | "morphNames">,
): Promise<MmdMotionCandidate[]> => {
  const motions = files.filter(isMmdMotionFile);
  if (!motions.length) return [];
  const { parseVmd } = await import("@yohawing/three-mmd-loader/parser");
  const target = motionTargetNames(model);
  const candidates: MmdMotionCandidate[] = [];
  for (const file of motions) {
    try {
      const animation = parseVmd(await file.arrayBuffer());
      const boneNames = Object.keys(animation.boneTracks);
      const morphNames = Object.keys(animation.morphTracks);
      candidates.push({
        file,
        path: normalizeAssetPath(file.webkitRelativePath || file.name),
        boneTrackCount: boneNames.length,
        morphTrackCount: morphNames.length,
        matchedBoneTrackCount: boneNames
          .filter((name) => target.bones.has(normalizeMelyBoneName(name))).length,
        matchedMorphTrackCount: morphNames
          .filter((name) => target.morphs.has(normalizeMelyBoneName(name))).length,
        maxFrame: animation.metadata.maxFrame,
      });
    } catch {
      // Invalid VMD files remain visible in the asset list but not in compatible track selectors.
    }
  }
  return candidates;
};

export const chooseMmdMotionTracks = async (
  files: readonly File[],
  model?: Pick<LoadedMmdModel, "bones" | "morphNames">,
) => {
  const motions = files.filter(isMmdMotionFile);
  if (!motions.length) return {};
  const candidates = await inspectMmdMotionCandidates(files, model);
  const selected = selectMmdMotionTrackCandidates(candidates);
  return {
    dance: selected.dance?.file,
    expression: selected.expression?.file,
  };
};
