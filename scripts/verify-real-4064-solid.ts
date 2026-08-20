import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  disposeMmdModel,
  FallbackCore,
  ThreeMmdLoader,
  type MmdAnimation,
} from "@yohawing/three-mmd-loader";
import { parseVmd } from "@yohawing/three-mmd-loader/parser";
import { unzipSync } from "fflate";
import { decode, type Tag } from "nbt-ts";
import { ungzip } from "pako";
import {
  ClampToEdgeWrapping,
  DataTexture,
  RGBAFormat,
  type MeshToonMaterial,
  type Texture,
} from "three";
import {
  confirmExtremeEnvironment,
  confirmExtremeExport,
  confirmExtremeUnlock,
  createExtremeHeightConfirmationState,
  extremeExportPhrase,
} from "../src/core/heightSafety";
import { streamLitematicFromDocument } from "../src/core/litematic";
import {
  isSuggestedEmissiveMaterial,
  isSuggestedSkinMaterial,
} from "../src/core/mmdModel";
import { createMmdMeshSnapshot } from "../src/core/mmdSnapshot";
import { createProjectionDocumentFromSolid } from "../src/core/projectionDocument";
import { estimateVoxelizationResources } from "../src/core/resourceBudget";
import { generateSolidVoxels } from "../src/core/solidVoxelizer";
import { estimateSolidVoxelizationWork } from "../src/core/solidVoxelWork";
import type {
  MeshMaterialSnapshot,
  MmdMeshSnapshot,
  ProjectionBounds,
  ProjectionDocument,
  SolidOptions,
} from "../src/types";

type Point = [number, number, number];

interface CliOptions {
  modelZip: string | null;
  pmxEntry: string | null;
  vmdPath: string | null;
  danceFrame: number;
  expressionFrame: number;
  targetHeight: number;
  outputDirectory: string;
  listPmx: boolean;
  includeLitematic: boolean;
}

interface ParsedPmxVertex {
  position: number[];
  uv: number[];
}

interface ParsedPmxFace {
  indices: number[];
}

interface ParsedPmxMaterial {
  name?: string;
  englishName?: string;
  diffuse: number[];
  ambient: number[];
  textureIndex: number;
  faceCount: number;
}

interface ParsedPmx {
  metadata: {
    format: string;
    coordinateSystem: string;
    modelName?: string;
    englishModelName?: string;
    vertexCount: number;
    faceCount: number;
    materialCount: number;
  };
  vertices: ParsedPmxVertex[];
  faces: ParsedPmxFace[];
  materials: ParsedPmxMaterial[];
}

interface StageMeasurement {
  elapsedMs: number;
  memoryBefore: NodeJS.MemoryUsage;
  memoryAfter: NodeJS.MemoryUsage;
  peakMemory: NodeJS.MemoryUsage;
}

interface StageResult<T> {
  value: T;
  measurement: StageMeasurement;
}

interface MotionSnapshotResult {
  snapshot: MmdMeshSnapshot;
  report: {
    vmdPath: string;
    vmdByteLength: number;
    vmdSha256: string;
    metadata: MmdAnimation["metadata"];
    requestedDanceFrame: number;
    appliedDanceFrame: number;
    requestedExpressionFrame: number;
    appliedExpressionFrame: number;
    matchedBoneTrackCount: number;
    matchedMorphTrackCount: number;
    bindPoseHash: string;
    posedPoseHash: string;
    changedVertexCount: number;
    maximumVertexDisplacement: number;
    ik: true;
    physics: false;
  };
}

interface DecodedRegionSummary {
  name: string;
  position: Point;
  size: Point;
  volume: number;
  paletteSize: number;
  canonicalPalette: string[];
  nonAirBlocks: number;
  minimum: Point | null;
  maximum: Point | null;
  semanticSha256: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = resolve(
  projectRoot,
  "release-validation",
  "real-4064-solid",
);
const DEFAULT_MODEL_ZIP = "/mnt/h/Downloads/爱莉希雅—霁月婵娟2.0_by_神帝宇_ed5668c5d5c3b3063039ec8a4e83f102.zip";
const DEFAULT_VMD = "/mnt/h/Downloads/AAA动作.vmd";
const DEFAULT_LONG_DRESS_PATTERN = /(?:爱莉)?长裙.*\.pmx$/i;
const MAX_4064_HEIGHT = 4_064;

const usage = `
真实 PMX 实体投影验收脚本

用法:
  node --import tsx scripts/verify-real-4064-solid.ts --model-zip <zip> [options]

参数:
  --model-zip <path>       包含 PMX 的 ZIP（默认使用当前真实爱莉希雅素材）
  --pmx-entry <entry>      ZIP 内 PMX 完整路径或唯一后缀（默认选长裙主体）
  --vmd <path>             动作/表情 VMD（默认 /mnt/h/Downloads/AAA动作.vmd）
  --dance-frame <n>        动作轨帧（默认 300，超出 VMD 时夹取）
  --expression-frame <n>   表情轨帧（默认 300，与动作轨独立）
  --static-pose            显式仅用绑定姿势；不算最终 4064 动作验收
  --target-height <n>      目标高度（默认 4064，小高度 smoke 请显式传入）
  --output <directory>     输出目录（默认 release-validation/real-4064-solid）
  --list-pmx               只列出 ZIP 内 PMX，不生成
  --no-litematic           只验证体素和 ProjectionDocument，不序列化
  --help                   显示帮助

完整 4064 验收示例:
  node --import tsx scripts/verify-real-4064-solid.ts --target-height 4064
`;

const parsePositiveInteger = (label: string, value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return parsed;
};

const parseNonNegativeInteger = (label: string, value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return parsed;
};

const parseCli = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    modelZip: DEFAULT_MODEL_ZIP,
    pmxEntry: null,
    vmdPath: DEFAULT_VMD,
    danceFrame: 300,
    expressionFrame: 300,
    targetHeight: MAX_4064_HEIGHT,
    outputDirectory: defaultOutputDirectory,
    listPmx: false,
    includeLitematic: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage.trim());
      process.exit(0);
    }
    if (argument === "--list-pmx") {
      options.listPmx = true;
      continue;
    }
    if (argument === "--no-litematic") {
      options.includeLitematic = false;
      continue;
    }
    if (argument === "--static-pose") {
      options.vmdPath = null;
      continue;
    }
    const next = argv[index + 1];
    if (argument === "--model-zip") {
      if (!next) throw new RangeError("--model-zip requires a path");
      options.modelZip = resolve(next);
      index += 1;
      continue;
    }
    if (argument === "--pmx-entry") {
      if (!next) throw new RangeError("--pmx-entry requires an entry name");
      options.pmxEntry = next.replaceAll("\\", "/");
      index += 1;
      continue;
    }
    if (argument === "--vmd") {
      if (!next) throw new RangeError("--vmd requires a path");
      options.vmdPath = resolve(next);
      index += 1;
      continue;
    }
    if (argument === "--dance-frame") {
      options.danceFrame = parseNonNegativeInteger("--dance-frame", next);
      index += 1;
      continue;
    }
    if (argument === "--expression-frame") {
      options.expressionFrame = parseNonNegativeInteger("--expression-frame", next);
      index += 1;
      continue;
    }
    if (argument === "--target-height") {
      options.targetHeight = parsePositiveInteger("--target-height", next);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      if (!next) throw new RangeError("--output requires a directory");
      options.outputDirectory = resolve(next);
      index += 1;
      continue;
    }
    throw new RangeError(`Unknown argument: ${argument}`);
  }
  if (!options.modelZip) throw new RangeError("--model-zip is required");
  if (options.targetHeight > MAX_4064_HEIGHT) {
    throw new RangeError(`Target height ${options.targetHeight} exceeds ${MAX_4064_HEIGHT}`);
  }
  if (options.targetHeight === MAX_4064_HEIGHT && !options.vmdPath) {
    throw new RangeError("Final 4064 validation requires --vmd; --static-pose is smoke-only");
  }
  return options;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const float32Sha256 = (values: Float32Array) => sha256(new Uint8Array(
  values.buffer,
  values.byteOffset,
  values.byteLength,
));

const memorySnapshot = (): NodeJS.MemoryUsage => ({ ...process.memoryUsage() });

const maximumMemory = (
  left: NodeJS.MemoryUsage,
  right: NodeJS.MemoryUsage,
): NodeJS.MemoryUsage => ({
  rss: Math.max(left.rss, right.rss),
  heapTotal: Math.max(left.heapTotal, right.heapTotal),
  heapUsed: Math.max(left.heapUsed, right.heapUsed),
  external: Math.max(left.external, right.external),
  arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
});

const measureStage = async <T>(
  task: () => T | Promise<T>,
): Promise<StageResult<T>> => {
  const memoryBefore = memorySnapshot();
  let peakMemory = memoryBefore;
  const sampler = setInterval(() => {
    peakMemory = maximumMemory(peakMemory, memorySnapshot());
  }, 25);
  sampler.unref();
  const startedAt = performance.now();
  try {
    const value = await task();
    const memoryAfter = memorySnapshot();
    peakMemory = maximumMemory(peakMemory, memoryAfter);
    return {
      value,
      measurement: {
        elapsedMs: performance.now() - startedAt,
        memoryBefore,
        memoryAfter,
        peakMemory,
      },
    };
  } finally {
    clearInterval(sampler);
  }
};

const pmxEntries = (zipBytes: Uint8Array) => unzipSync(zipBytes, {
  filter: (entry) => /\.pmx$/i.test(entry.name),
});

const selectPmxEntry = (
  entries: Record<string, Uint8Array>,
  requested: string | null,
) => {
  const names = Object.keys(entries).sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (names.length === 0) throw new Error("The model ZIP contains no PMX entries");
  if (requested) {
    const exact = names.filter((name) => name === requested);
    if (exact.length === 1) return exact[0];
    const suffix = names.filter((name) => name.endsWith(requested));
    if (suffix.length === 1) return suffix[0];
    if (suffix.length > 1) {
      throw new Error(`--pmx-entry is ambiguous: ${suffix.join(", ")}`);
    }
    throw new Error(`PMX entry not found: ${requested}`);
  }
  const longDress = names.filter((name) => DEFAULT_LONG_DRESS_PATTERN.test(name));
  if (longDress.length === 1) return longDress[0];
  if (longDress.length > 1) {
    return longDress.sort((left, right) => entries[right].byteLength - entries[left].byteLength)[0];
  }
  return names.sort((left, right) => entries[right].byteLength - entries[left].byteLength)[0];
};

const parsePmx = async (bytes: Uint8Array): Promise<ParsedPmx> => {
  // three-stdlib 未在 package exports 公开 Parser，但 MMDLoader 本身也使用同一内部模块。
  const parserModuleUrl = new URL("../node_modules/three-stdlib/libs/mmdparser.js", import.meta.url);
  const { Parser } = await import(pathToFileURL(fileURLToPath(parserModuleUrl)).href) as {
    Parser: new () => { parsePmx: (buffer: ArrayBuffer, leftToRight: boolean) => ParsedPmx };
  };
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const parsed = new Parser().parsePmx(buffer, true);
  assert.equal(parsed.metadata.coordinateSystem, "right", "PMX parser did not convert to right-handed coordinates");
  return parsed;
};

const tuple = <T extends number[]>(
  values: readonly number[],
  length: T["length"],
  fallback: T,
): T => values.length >= length
  ? values.slice(0, length) as T
  : fallback;

const createMaterials = (pmx: ParsedPmx): MeshMaterialSnapshot[] => pmx.materials.map((material) => {
  const name = material.name ?? "";
  const englishName = material.englishName ?? "";
  return {
    name,
    englishName,
    baseColor: tuple<[number, number, number, number]>(material.diffuse, 4, [1, 1, 1, 1]),
    textureFactor: [1, 1, 1, 1],
    textureAdditiveFactor: [0, 0, 0, 0],
    // CLI 不解码图像，故显式按 PMX diffuse 颜色验收几何与导出主链。
    hasTexture: false,
    textureIndex: -1,
    textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    flipY: false,
    ambient: tuple<[number, number, number]>(material.ambient, 3, [0, 0, 0]),
    emissive: isSuggestedEmissiveMaterial(name, englishName),
  };
});

const createSnapshot = (pmx: ParsedPmx): MmdMeshSnapshot => {
  const positions = new Float32Array(pmx.vertices.length * 3);
  const uvs = new Float32Array(pmx.vertices.length * 2);
  pmx.vertices.forEach((vertex, index) => {
    positions.set(vertex.position.slice(0, 3), index * 3);
    uvs.set(vertex.uv.slice(0, 2), index * 2);
  });
  const indices = new Uint32Array(pmx.faces.length * 3);
  pmx.faces.forEach((face, index) => indices.set(face.indices.slice(0, 3), index * 3));
  const triangleMaterials = new Uint16Array(pmx.faces.length);
  let triangleOffset = 0;
  pmx.materials.forEach((material, materialIndex) => {
    if (!Number.isSafeInteger(material.faceCount) || material.faceCount < 0) {
      throw new RangeError(`PMX material ${materialIndex} has an invalid face count`);
    }
    triangleMaterials.fill(materialIndex, triangleOffset, triangleOffset + material.faceCount);
    triangleOffset += material.faceCount;
  });
  assert.equal(triangleOffset, pmx.faces.length, "PMX material face counts do not cover all triangles");
  return {
    positions,
    uvs,
    indices,
    triangleMaterials,
    materials: createMaterials(pmx),
    textures: [],
  };
};

const sampleMorphTrack = (track: MmdAnimation["morphTracks"][string], frame: number) => {
  if (track.frames.length === 0) return 0;
  if (frame <= track.frames[0]) return track.weights[0] ?? 0;
  let low = 1;
  let high = track.frames.length - 1;
  let next = track.frames.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frame < track.frames[middle]) {
      next = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (next >= track.frames.length) return track.weights[track.weights.length - 1] ?? 0;
  const previous = next - 1;
  const span = track.frames[next] - track.frames[previous];
  const ratio = span > 0 ? (frame - track.frames[previous]) / span : 0;
  return (track.weights[previous] ?? 0)
    + ((track.weights[next] ?? 0) - (track.weights[previous] ?? 0)) * ratio;
};

const combinedMotion = (
  animation: MmdAnimation,
  expressionFrame: number,
): MmdAnimation => ({
  ...animation,
  morphTracks: Object.fromEntries(Object.entries(animation.morphTracks).map(([name, track]) => [
    name,
    {
      packed: "morph" as const,
      frames: new Uint32Array([0]),
      weights: new Float32Array([sampleMorphTrack(track, expressionFrame)]),
    },
  ])),
});

const dummyTextureLoader = {
  load: (
    _url: string,
    onLoad?: (texture: Texture) => void,
  ) => {
    const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    texture.needsUpdate = true;
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  },
};

const ensureNodeWindowTimer = () => {
  if (!("window" in globalThis)) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
};

const createMotionSnapshot = async (
  pmxBytes: Uint8Array,
  vmdPath: string,
  requestedDanceFrame: number,
  requestedExpressionFrame: number,
): Promise<MotionSnapshotResult> => {
  ensureNodeWindowTimer();
  const vmdBytes = new Uint8Array(await readFile(vmdPath));
  const animation = parseVmd(vmdBytes);
  const appliedDanceFrame = Math.min(requestedDanceFrame, animation.metadata.maxFrame);
  const appliedExpressionFrame = Math.min(requestedExpressionFrame, animation.metadata.maxFrame);
  const loader = new ThreeMmdLoader({
    core: new FallbackCore(),
    textureResolver: { resolve: async () => undefined },
    textureLoader: dummyTextureLoader,
    runtime: { physics: "none" },
  });
  const model = await loader.loadModel(pmxBytes, {
    outline: false,
    materialRenderOrder: false,
    morphSplit: false,
    morphAttributes: true,
    frustumCulled: false,
  });
  const bindSnapshot = await createMmdMeshSnapshot(
    { root: model.root, mesh: model.mesh },
    { includeTextures: false },
  );
  const boneNames = new Set(model.mesh.skeleton.bones.flatMap((bone) => [
    bone.name,
    typeof bone.userData.mmdEnglishBoneName === "string"
      ? bone.userData.mmdEnglishBoneName
      : "",
  ]).filter(Boolean));
  const morphNames = new Set(Object.keys(model.mesh.morphTargetDictionary ?? {}));
  const matchedBoneTrackCount = Object.keys(animation.boneTracks)
    .filter((name) => boneNames.has(name)).length;
  const matchedMorphTrackCount = Object.keys(animation.morphTracks)
    .filter((name) => morphNames.has(name)).length;
  if (matchedBoneTrackCount === 0) throw new Error("VMD has no bone tracks compatible with the PMX");

  model.setAnimation(combinedMotion(animation, appliedExpressionFrame));
  model.update(appliedDanceFrame / 30, { physics: false, ik: true });
  model.root.updateMatrixWorld(true);
  model.mesh.skeleton.update();
  const snapshot = await createMmdMeshSnapshot(
    { root: model.root, mesh: model.mesh },
    { includeTextures: false },
  );
  assert.equal(snapshot.positions.length, bindSnapshot.positions.length);
  let changedVertexCount = 0;
  let maximumVertexDisplacement = 0;
  for (let offset = 0; offset < snapshot.positions.length; offset += 3) {
    const displacement = Math.hypot(
      snapshot.positions[offset] - bindSnapshot.positions[offset],
      snapshot.positions[offset + 1] - bindSnapshot.positions[offset + 1],
      snapshot.positions[offset + 2] - bindSnapshot.positions[offset + 2],
    );
    if (displacement > 1e-5) changedVertexCount += 1;
    maximumVertexDisplacement = Math.max(maximumVertexDisplacement, displacement);
  }
  if (changedVertexCount === 0) throw new Error("VMD evaluation did not change any PMX vertices");

  const materialList = Array.isArray(model.mesh.material)
    ? model.mesh.material
    : [model.mesh.material];
  snapshot.materials = materialList.map((material, index) => {
    const mmd = material.userData.mmdMaterial as {
      name?: string;
      englishName?: string;
      diffuse?: number[];
      ambient?: number[];
    } | undefined;
    const toon = material as MeshToonMaterial;
    const baseColor = mmd?.diffuse ?? [toon.color.r, toon.color.g, toon.color.b, material.opacity];
    const name = mmd?.name ?? material.name ?? "";
    const englishName = mmd?.englishName ?? "";
    return {
      name,
      englishName,
      baseColor: tuple<[number, number, number, number]>(baseColor, 4, [1, 1, 1, 1]),
      textureFactor: [1, 1, 1, 1],
      textureAdditiveFactor: [0, 0, 0, 0],
      hasTexture: false,
      textureIndex: -1,
      textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      flipY: false,
      ambient: tuple<[number, number, number]>(mmd?.ambient ?? [], 3, [0, 0, 0]),
      emissive: isSuggestedEmissiveMaterial(name, englishName),
    } satisfies MeshMaterialSnapshot;
  });
  snapshot.textures = [];
  const bindPoseHash = float32Sha256(bindSnapshot.positions);
  const posedPoseHash = float32Sha256(snapshot.positions);
  bindSnapshot.positions = new Float32Array(0);
  disposeMmdModel(model, { textures: "owned" });
  return {
    snapshot,
    report: {
      vmdPath,
      vmdByteLength: vmdBytes.byteLength,
      vmdSha256: sha256(vmdBytes),
      metadata: animation.metadata,
      requestedDanceFrame,
      appliedDanceFrame,
      requestedExpressionFrame,
      appliedExpressionFrame,
      matchedBoneTrackCount,
      matchedMorphTrackCount,
      bindPoseHash,
      posedPoseHash,
      changedVertexCount,
      maximumVertexDisplacement,
      ik: true,
      physics: false,
    },
  };
};

const solidOptions = (pmx: ParsedPmx, targetHeight: number): SolidOptions => ({
  targetHeight,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "clean",
  faceDetail: "off",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: pmx.materials.flatMap((material, index) => (
    isSuggestedEmissiveMaterial(material.name ?? "", material.englishName ?? "") ? [index] : []
  )),
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: pmx.materials.flatMap((material, index) => (
    isSuggestedSkinMaterial(material.name ?? "", material.englishName ?? "") ? [index] : []
  )),
  excludeGravity: true,
  excludeRare: true,
});

const snapshotDimensions = (
  snapshot: MmdMeshSnapshot,
  targetHeight: number,
): Point => {
  const minimum: Point = [Infinity, Infinity, Infinity];
  const maximum: Point = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < snapshot.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = snapshot.positions[offset + axis];
      if (!Number.isFinite(value)) throw new RangeError("PMX contains a non-finite vertex");
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  const sourceHeight = maximum[1] - minimum[1];
  if (!(sourceHeight > 1e-6)) throw new RangeError("PMX source height is too small");
  const scale = Math.max(1, targetHeight - 1) / sourceHeight;
  return [
    Math.max(1, Math.ceil((maximum[0] - minimum[0]) * scale) + 1),
    targetHeight,
    Math.max(1, Math.ceil((maximum[2] - minimum[2]) * scale) + 1),
  ];
};

const intValue = (value: unknown, context: string) => {
  const primitive = value && typeof value === "object" && "valueOf" in value
    ? (value as { valueOf: () => unknown }).valueOf()
    : value;
  if (typeof primitive !== "number" || !Number.isSafeInteger(primitive)) {
    throw new TypeError(`${context} is not a safe NBT integer`);
  }
  return primitive;
};

const stringValue = (value: unknown, context: string) => {
  const primitive = value && typeof value === "object" && "valueOf" in value
    ? (value as { valueOf: () => unknown }).valueOf()
    : value;
  if (typeof primitive !== "string") {
    throw new TypeError(`${context} is not an NBT string`);
  }
  return primitive;
};

const canonicalBlockState = (value: unknown, context: string) => {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${context} is not an NBT compound`);
  }
  const state = value as Record<string, unknown>;
  const name = stringValue(state.Name, `${context}.Name`);
  if (state.Properties === undefined) return name;
  if (!state.Properties || typeof state.Properties !== "object") {
    throw new TypeError(`${context}.Properties is not an NBT compound`);
  }
  const properties = Object.entries(state.Properties as Record<string, unknown>)
    .map(([key, property]) => [key, stringValue(property, `${context}.Properties.${key}`)] as const)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"));
  return properties.length === 0
    ? name
    : `${name}[${properties.map(([key, property]) => `${key}=${property}`).join(",")}]`;
};

const createRegionSemanticHasher = (
  position: Point,
  size: Point,
  palette: unknown[],
) => {
  const canonicalPalette = palette.map((state, index) => (
    canonicalBlockState(state, `BlockStatePalette[${index}]`)
  ));
  assert.equal(canonicalPalette[0], "minecraft:air", "Litematic palette index 0 must be air");
  const canonicalStates = [...new Set(canonicalPalette)].sort((left, right) => (
    left.localeCompare(right, "en-US")
  ));
  const canonicalIndices = canonicalPalette.map((state) => canonicalStates.indexOf(state));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ position, size, states: canonicalStates }));

  // 固定宽度批量记录避免对数千万方块逐个创建 Buffer 或调用 hash.update。
  const recordsPerBatch = 4_096;
  const recordSize = 12;
  const batch = new Uint8Array(recordsPerBatch * recordSize);
  const view = new DataView(batch.buffer);
  let batchLength = 0;
  const flush = () => {
    if (batchLength === 0) return;
    hash.update(batch.subarray(0, batchLength));
    batchLength = 0;
  };
  const append = (linearIndex: number, paletteIndex: number) => {
    const canonicalIndex = canonicalIndices[paletteIndex];
    if (canonicalIndex === undefined) {
      throw new RangeError(`Palette index ${paletteIndex} is outside BlockStatePalette`);
    }
    if (batchLength + recordSize > batch.byteLength) flush();
    view.setBigUint64(batchLength, BigInt(linearIndex), false);
    view.setUint32(batchLength + 8, canonicalIndex, false);
    batchLength += recordSize;
  };
  return {
    canonicalPalette,
    append,
    digest: () => {
      flush();
      return hash.digest("hex");
    },
  };
};

const pointTag = (value: unknown, context: string): Point => {
  if (!value || typeof value !== "object") throw new TypeError(`${context} is not an NBT compound`);
  const compound = value as Record<string, unknown>;
  return ["x", "y", "z"].map((axis) => intValue(compound[axis], `${context}.${axis}`)) as Point;
};

const expandBounds = (
  minimum: Point,
  maximum: Point,
  point: Point,
) => {
  for (let axis = 0; axis < 3; axis += 1) {
    minimum[axis] = Math.min(minimum[axis], point[axis]);
    maximum[axis] = Math.max(maximum[axis], point[axis]);
  }
};

const unpackPaletteIndex = (
  packed: BigInt64Array,
  index: number,
  bitsPerBlock: number,
) => {
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const bitOffset = index * bitsPerBlock;
  const longIndex = Math.floor(bitOffset / 64);
  const innerOffset = bitOffset & 63;
  const first = BigInt.asUintN(64, packed[longIndex]);
  const available = 64 - innerOffset;
  if (available >= bitsPerBlock) {
    return Number((first >> BigInt(innerOffset)) & mask);
  }
  const second = BigInt.asUintN(64, packed[longIndex + 1]);
  return Number(((first >> BigInt(innerOffset)) | (second << BigInt(available))) & mask);
};

const decodeLitematic = (bytes: Uint8Array) => {
  const uncompressed = ungzip(bytes);
  const decoded = decode(Buffer.from(uncompressed));
  assert.equal(decoded.length, uncompressed.byteLength, "NBT decoder did not consume the complete Litematic");
  if (!decoded.value || typeof decoded.value !== "object") throw new TypeError("Litematic root is empty");
  const root = decoded.value as Record<string, Tag>;
  const metadata = root.Metadata as Record<string, Tag>;
  const regions = root.Regions as Record<string, Tag>;
  if (!metadata || !regions) throw new TypeError("Litematic metadata or regions are missing");
  const regionSummaries: DecodedRegionSummary[] = [];
  let totalNonAirBlocks = 0;
  const minimum: Point = [Infinity, Infinity, Infinity];
  const maximum: Point = [-Infinity, -Infinity, -Infinity];
  for (const [name, regionTag] of Object.entries(regions)) {
    const region = regionTag as Record<string, Tag>;
    const position = pointTag(region.Position, `Regions.${name}.Position`);
    const size = pointTag(region.Size, `Regions.${name}.Size`);
    if (size.some((dimension) => dimension <= 0)) {
      throw new RangeError(`Region ${name} has a non-positive size`);
    }
    const palette = region.BlockStatePalette;
    const packed = region.BlockStates;
    if (!Array.isArray(palette) || !(packed instanceof BigInt64Array)) {
      throw new TypeError(`Region ${name} has invalid palette or block-state buffers`);
    }
    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))));
    const volume = size[0] * size[1] * size[2];
    if (!Number.isSafeInteger(volume)) throw new RangeError(`Region ${name} volume exceeds safe arithmetic`);
    const semantic = createRegionSemanticHasher(
      position,
      size,
      palette,
    );
    const regionMinimum: Point = [Infinity, Infinity, Infinity];
    const regionMaximum: Point = [-Infinity, -Infinity, -Infinity];
    let nonAirBlocks = 0;
    for (let linearIndex = 0; linearIndex < volume; linearIndex += 1) {
      const paletteIndex = unpackPaletteIndex(packed, linearIndex, bitsPerBlock);
      if (paletteIndex === 0) continue;
      if (!palette[paletteIndex]) throw new RangeError(`Region ${name} references palette ${paletteIndex}`);
      semantic.append(linearIndex, paletteIndex);
      const x = linearIndex % size[0];
      const yz = Math.floor(linearIndex / size[0]);
      const z = yz % size[2];
      const y = Math.floor(yz / size[2]);
      const point: Point = [position[0] + x, position[1] + y, position[2] + z];
      expandBounds(regionMinimum, regionMaximum, point);
      expandBounds(minimum, maximum, point);
      nonAirBlocks += 1;
    }
    totalNonAirBlocks += nonAirBlocks;
    regionSummaries.push({
      name,
      position,
      size,
      volume,
      paletteSize: palette.length,
      canonicalPalette: semantic.canonicalPalette,
      nonAirBlocks,
      minimum: nonAirBlocks > 0 ? regionMinimum : null,
      maximum: nonAirBlocks > 0 ? regionMaximum : null,
      semanticSha256: semantic.digest(),
    });
  }
  const semanticHash = createHash("sha256");
  const semanticRegions = [...regionSummaries]
    .sort((left, right) => (
      left.position[1] - right.position[1]
      || left.position[2] - right.position[2]
      || left.position[0] - right.position[0]
      || left.size[1] - right.size[1]
      || left.size[2] - right.size[2]
      || left.size[0] - right.size[0]
    ));
  for (const region of semanticRegions) {
    // Region 名称不属于投影语义，避免仅命名差异导致 parity 误报。
    semanticHash.update(JSON.stringify({
      position: region.position,
      size: region.size,
      semanticSha256: region.semanticSha256,
    }));
  }
  return {
    version: intValue(root.Version, "Version"),
    subVersion: intValue(root.SubVersion, "SubVersion"),
    minecraftDataVersion: intValue(root.MinecraftDataVersion, "MinecraftDataVersion"),
    enclosingSize: pointTag(metadata.EnclosingSize, "Metadata.EnclosingSize"),
    totalBlocks: intValue(metadata.TotalBlocks, "Metadata.TotalBlocks"),
    totalVolume: intValue(metadata.TotalVolume, "Metadata.TotalVolume"),
    regionCount: intValue(metadata.RegionCount, "Metadata.RegionCount"),
    decodedRegionCount: regionSummaries.length,
    totalNonAirBlocks,
    minimum: totalNonAirBlocks > 0 ? minimum : null,
    maximum: totalNonAirBlocks > 0 ? maximum : null,
    semanticSha256: semanticHash.digest("hex"),
    regions: regionSummaries,
  };
};

const relativeBounds = (bounds: ProjectionBounds): ProjectionBounds => ({
  min: [0, 0, 0],
  max: bounds.dimensions.map((dimension) => dimension - 1) as Point,
  dimensions: [...bounds.dimensions],
});

const exportSafety = (targetHeight: number) => {
  const heightMode = targetHeight > 2_032 ? "experimental_4064" as const : (
    targetHeight > 384 ? "extended_2032" as const : "default" as const
  );
  if (heightMode !== "experimental_4064") {
    const targetDimension = heightMode === "extended_2032"
      ? { minY: -1_016, height: 2_032 }
      : { minY: -64, height: 384 };
    return {
      heightMode,
      targetHeight,
      datapackAcknowledged: targetHeight > 384,
      placementBottomY: targetDimension.minY,
      targetDimension,
    };
  }
  const configurationFingerprint = `real-4064-harness:${targetHeight}`;
  const exportFingerprint = `${configurationFingerprint}:litematic`;
  const unlocked = confirmExtremeUnlock(
    createExtremeHeightConfirmationState(),
    configurationFingerprint,
    "CLI explicit 4064 validation",
    1,
  );
  const environment = confirmExtremeEnvironment(
    unlocked,
    configurationFingerprint,
    "CLI datapack dimension min_y=-2032 height=4064",
    2,
  );
  const confirmations = confirmExtremeExport(
    environment,
    configurationFingerprint,
    exportFingerprint,
    extremeExportPhrase(targetHeight),
    targetHeight,
    "CLI explicit Litematic export",
    3,
  );
  return {
    heightMode,
    targetHeight,
    datapackAcknowledged: true,
    placementBottomY: -2_032,
    targetDimension: { minY: -2_032, height: 4_064 },
    configurationFingerprint,
    exportFingerprint,
    confirmations,
  };
};

const worldContractReport = (targetHeight: number) => {
  const safety = exportSafety(targetHeight);
  return {
    heightMode: safety.heightMode,
    targetHeight,
    targetDimension: {
      minY: safety.targetDimension.minY,
      maxY: safety.targetDimension.minY + safety.targetDimension.height - 1,
      height: safety.targetDimension.height,
    },
    placementBottomY: safety.placementBottomY,
    datapackAcknowledged: safety.datapackAcknowledged,
    configurationFingerprint: "configurationFingerprint" in safety
      ? safety.configurationFingerprint
      : null,
    exportFingerprint: "exportFingerprint" in safety ? safety.exportFingerprint : null,
    confirmations: "confirmations" in safety ? safety.confirmations : null,
  };
};

const assertDecodedLitematic = (
  decoded: ReturnType<typeof decodeLitematic>,
  document: ProjectionDocument,
  targetHeight: number,
) => {
  if (!document.bounds) throw new Error("ProjectionDocument is empty");
  assert.equal(decoded.version, 6);
  assert.equal(decoded.subVersion, 1);
  assert.equal(decoded.minecraftDataVersion, 3465);
  assert.deepEqual(decoded.enclosingSize, document.bounds.dimensions);
  assert.equal(decoded.enclosingSize[1], targetHeight);
  assert.equal(decoded.totalBlocks, document.blockCount);
  assert.equal(decoded.totalNonAirBlocks, document.blockCount);
  assert.equal(decoded.regionCount, decoded.decodedRegionCount);
  assert.deepEqual(decoded.minimum, relativeBounds(document.bounds).min);
  assert.deepEqual(decoded.maximum, relativeBounds(document.bounds).max);
};

const buildResourceReport = (
  snapshot: MmdMeshSnapshot,
  options: SolidOptions,
  dimensions: Point,
) => {
  const surfaceEstimate = Math.max(
    1,
    Math.round(2 * (
      dimensions[0] * dimensions[1]
      + dimensions[0] * dimensions[2]
      + dimensions[1] * dimensions[2]
    ) * 0.58),
  );
  const resources = estimateVoxelizationResources({
    targetHeight: options.targetHeight,
    width: dimensions[0],
    depth: dimensions[2],
    triangleCount: snapshot.indices.length / 3,
    textureBytes: 0,
    fillMode: options.fillMode,
    estimatedBlocks: surfaceEstimate,
  });
  const work = estimateSolidVoxelizationWork(
    snapshot,
    options.targetHeight,
    options.thicknessCompensation,
  );
  return {
    dimensions,
    resources,
    work: {
      totalCandidateUpperBound: work.totalCandidateUpperBound,
      maxTriangleCandidateUpperBound: work.maxTriangleCandidateUpperBound,
      maxTriangleIndex: work.maxTriangleIndex,
      legacyAabbCandidateTests: work.legacyAabbCandidateTests,
      maxLegacyAabbCandidateTests: work.maxLegacyAabbCandidateTests,
      saturated: work.saturated,
    },
    warnings: [
      ...(resources.requiresConfirmation
        ? [`Resource estimate requires confirmation: ${resources.risks.join(", ")}`]
        : []),
      ...(work.saturated ? ["Candidate work estimate saturated safe-integer arithmetic"] : []),
    ],
  };
};

const assertSolidChunkContract = (
  chunks: NonNullable<ReturnType<typeof generateSolidVoxels>["chunks"]>,
) => {
  let previousChunk: Point | null = null;
  for (const chunk of chunks) {
    if (previousChunk) {
      const order = chunk.chunk[1] - previousChunk[1]
        || chunk.chunk[2] - previousChunk[2]
        || chunk.chunk[0] - previousChunk[0];
      assert.ok(order > 0, "Solid chunks are not strictly ordered by Y/Z/X");
    }
    assert.equal(chunk.positions.length, chunk.blockIndices.length);
    for (let index = 0; index < chunk.positions.length; index += 1) {
      assert.ok(chunk.positions[index] < 32 ** 3, "Solid chunk local index is outside 32^3");
      if (index > 0) {
        assert.ok(
          chunk.positions[index] > chunk.positions[index - 1],
          "Solid chunk local indices are not strictly increasing",
        );
      }
    }
    previousChunk = chunk.chunk;
  }
};

const reportError = async (
  outputDirectory: string,
  startedAt: number,
  error: unknown,
) => {
  await mkdir(outputDirectory, { recursive: true });
  const failure = {
    status: "failed",
    generatedAt: new Date().toISOString(),
    elapsedMs: performance.now() - startedAt,
    memory: memorySnapshot(),
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "UnknownError", message: String(error) },
  };
  await writeFile(
    resolve(outputDirectory, "failure.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
  );
};

const main = async () => {
  const startedAt = performance.now();
  const cli = parseCli(process.argv.slice(2));
  try {
    const zipPath = resolve(cli.modelZip!);
    const archive = await measureStage(async () => new Uint8Array(await readFile(zipPath)));
    const extracted = await measureStage(() => pmxEntries(archive.value));
    const entries = Object.entries(extracted.value).map(([name, bytes]) => ({
      name,
      byteLength: bytes.byteLength,
    }));
    if (cli.listPmx) {
      console.log(JSON.stringify({ modelZip: zipPath, entries }, null, 2));
      return;
    }

    const selectedEntry = selectPmxEntry(extracted.value, cli.pmxEntry);
    const pmxBytes = extracted.value[selectedEntry];
    const parsed = await measureStage(() => parsePmx(pmxBytes));
    const snapshotStage = await measureStage(async () => cli.vmdPath
      ? createMotionSnapshot(
          pmxBytes,
          cli.vmdPath,
          cli.danceFrame,
          cli.expressionFrame,
        )
      : { snapshot: createSnapshot(parsed.value), report: null });
    const snapshot = snapshotStage.value.snapshot;
    const options = solidOptions(parsed.value, cli.targetHeight);
    const dimensions = snapshotDimensions(snapshot, cli.targetHeight);
    const preflight = await measureStage(() => buildResourceReport(snapshot, options, dimensions));

    preflight.value.warnings.forEach((warning) => console.warn(`WARNING: ${warning}`));
    console.log(JSON.stringify({
      stage: "preflight",
      targetHeight: cli.targetHeight,
      model: selectedEntry,
      motion: snapshotStage.value.report,
      dimensions,
      warnings: preflight.value.warnings,
      work: preflight.value.work,
    }));

    let lastProgress = -1;
    const generated = await measureStage(() => generateSolidVoxels(
      snapshot,
      options,
      (stage, progress) => {
        const percentage = Math.floor(progress * 100);
        if (percentage >= lastProgress + 5 || percentage === 100) {
          lastProgress = percentage;
          console.log(JSON.stringify({ stage, progress: percentage }));
        }
      },
      // 验收始终覆盖 typed-chunk 主路，避免小高度 smoke 只测到旧 flat 路径。
      { flatVoxelLimit: 0 },
    ));
    const documentStage = await measureStage(() => createProjectionDocumentFromSolid(
      generated.value,
      {
        minecraftVersion: "1.20.1",
        metadata: {
          source: "real-pmx-solid-validation",
          targetHeight: cli.targetHeight,
          heightMode: cli.targetHeight > 2_032 ? "experimental_4064" : (
            cli.targetHeight > 384 ? "extended_2032" : "default"
          ),
          textureCapture: false,
        },
      },
    ));
    const document = documentStage.value;
    assert.ok(document.bounds, "Generated projection is empty");
    assert.equal(document.bounds.dimensions[1], cli.targetHeight);
    assert.equal(document.blockCount, generated.value.stats.blockCount);
    assert.equal(generated.value.storage, "chunked");
    assert.ok(generated.value.chunks?.length, "Typed chunk output is empty");
    assertSolidChunkContract(generated.value.chunks!);

    await mkdir(cli.outputDirectory, { recursive: true });
    let litematicReport: Record<string, unknown> | null = null;
    let litematicMeasurement: StageMeasurement | null = null;
    if (cli.includeLitematic) {
      const litematicPath = resolve(
        cli.outputDirectory,
        `real-pmx-solid-${cli.targetHeight}.litematic`,
      );
      const exported = await measureStage(async () => {
        const handle = await open(litematicPath, "w");
        try {
          return await streamLitematicFromDocument(document, (chunk) => handle.write(chunk).then(
            ({ bytesWritten }) => {
              if (bytesWritten !== chunk.byteLength) {
                throw new Error(
                  `Incomplete Litematic write: ${bytesWritten}/${chunk.byteLength} bytes`,
                );
              }
            },
          ), {
            name: `MELY Real PMX Solid ${cli.targetHeight}`,
            author: "MELY",
            description: "Real PMX solid projection validation; diffuse-only CLI snapshot",
            timestamp: 1,
            regionMaxSize: 32,
            // CLI 参数表达用户主动发起本次验收，完整构造三阶段确认指纹。
            safety: exportSafety(cli.targetHeight),
          });
        } finally {
          await handle.close();
        }
      });
      const litematicBytes = new Uint8Array(await readFile(litematicPath));
      assert.equal(litematicBytes.byteLength, exported.value.byteLength);
      const decoded = await measureStage(() => decodeLitematic(litematicBytes));
      assertDecodedLitematic(decoded.value, document, cli.targetHeight);
      litematicMeasurement = exported.measurement;
      litematicReport = {
        path: litematicPath,
        byteLength: litematicBytes.byteLength,
        sha256: sha256(litematicBytes),
        summary: exported.value,
        decoded: decoded.value,
        decodeMeasurement: decoded.measurement,
      };
    }

    const report = {
      status: "passed",
      generatedAt: new Date().toISOString(),
      elapsedMs: performance.now() - startedAt,
      command: {
        modelZip: zipPath,
        pmxEntry: selectedEntry,
        vmdPath: cli.vmdPath,
        danceFrame: cli.danceFrame,
        expressionFrame: cli.expressionFrame,
        targetHeight: cli.targetHeight,
        outputDirectory: cli.outputDirectory,
        includeLitematic: cli.includeLitematic,
      },
      limitations: [
        ...(cli.vmdPath
          ? ["CLI VMD evaluation applies bone/morph tracks and IK but disables physics for deterministic validation."]
          : ["CLI snapshot uses the static bind pose; this mode does not qualify as final 4064 motion acceptance."]),
        "CLI snapshot intentionally omits texture decoding; hasTexture=false and PMX diffuse colors are used. UI texture-capture color fidelity remains a separate acceptance path.",
      ],
      source: {
        zipByteLength: archive.value.byteLength,
        zipSha256: sha256(archive.value),
        pmxByteLength: pmxBytes.byteLength,
        pmxSha256: sha256(pmxBytes),
        availablePmxEntries: entries,
        metadata: parsed.value.metadata,
      },
      motion: snapshotStage.value.report,
      options,
      worldContract: worldContractReport(cli.targetHeight),
      preflight: preflight.value,
      result: {
        storage: generated.value.storage ?? "flat",
        chunkCount: generated.value.chunks?.length ?? 0,
        stats: generated.value.stats,
        bounds: generated.value.bounds,
        paletteSize: generated.value.palette.length,
      },
      document: {
        blockCount: document.blockCount,
        chunkCount: document.chunks.length,
        paletteSize: document.palette.length,
        bounds: document.bounds,
      },
      litematic: litematicReport,
      measurements: {
        archiveRead: archive.measurement,
        pmxExtract: extracted.measurement,
        pmxParse: parsed.measurement,
        snapshot: snapshotStage.measurement,
        preflight: preflight.measurement,
        voxelization: generated.measurement,
        projectionDocument: documentStage.measurement,
        litematic: litematicMeasurement,
        finalMemory: memorySnapshot(),
      },
    };
    const reportPath = resolve(cli.outputDirectory, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      status: report.status,
      reportPath,
      targetHeight: cli.targetHeight,
      blockCount: document.blockCount,
      dimensions: document.bounds.dimensions,
      litematic: litematicReport && (litematicReport.path as string),
    }, null, 2));
  } catch (error) {
    await reportError(cli.outputDirectory, startedAt, error);
    throw error;
  }
};

const invokedDirectly = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (invokedDirectly) {
  await main();
}

export {
  createMotionSnapshot,
  createSnapshot,
  decodeLitematic,
  exportSafety,
  parsePmx,
  pmxEntries,
  selectPmxEntry,
  solidOptions,
  worldContractReport,
};
