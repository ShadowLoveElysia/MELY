import type {
  ProjectionBlockState,
  ProjectionChunk,
  ProjectionDocument,
} from "../types";
import { PROJECTION_CHUNK_SIZE } from "./projectionDocument";
import { resolveBedrockBlockState, type ResolvedBedrockBlockState } from "./mcstructure";
import { DEFAULT_BEDROCK_VERSION } from "./minecraftVersions";
import { strToU8 } from "fflate";
import {
  combineZipChunks,
  createZipStreamWriter,
  type ZipChunkSink,
  type ZipStreamSummary,
} from "./zipStream";

type Point = [number, number, number];

interface CommandSegment {
  start: Point;
  end: Point;
  paletteIndex: number;
}

export interface McfunctionExportOptions {
  namespace?: string;
  packName?: string;
  description?: string;
  maxLineLength?: number;
  maxCommandsPerFunction?: number;
  minFillLength?: number;
  headerUuid?: string;
  moduleUuid?: string;
  minEngineVersion?: [number, number, number];
}

export interface McfunctionFile {
  path: string;
  functionId: string;
  content: string;
  commandCount: number;
}

export interface McfunctionManifest {
  format_version: 2;
  header: {
    name: string;
    description: string;
    uuid: string;
    version: [number, number, number];
    min_engine_version: [number, number, number];
  };
  modules: Array<{
    type: "data";
    uuid: string;
    version: [number, number, number];
  }>;
}

export interface McfunctionExportSummary {
  blockCount: number;
  commandCount: number;
  fillCount: number;
  setblockCount: number;
  functionCount: number;
  maxLineLength: number;
  maxCommandsPerFunction: number;
}

export interface McfunctionExportMetadata {
  manifest: McfunctionManifest;
  entryFunction: string;
  summary: McfunctionExportSummary;
}

export interface McfunctionExport extends McfunctionExportMetadata {
  files: McfunctionFile[];
}

export interface McfunctionZipOptions extends McfunctionExportOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface StreamedMcfunctionZip extends McfunctionExportMetadata {
  archive: ZipStreamSummary;
}

export interface McfunctionZip extends StreamedMcfunctionZip {
  bytes: Uint8Array;
}

export type McfunctionFileHandler = (file: McfunctionFile) => void | Promise<void>;

interface McfunctionGenerationPlan {
  document: ProjectionDocument;
  chunks: ProjectionChunk[];
  namespace: string;
  anchor: Point;
  paletteCommands: string[];
  maxLineLength: number;
  maxCommands: number;
  minFillLength: number;
  manifest: McfunctionManifest;
  entryFunction: string;
}

const DEFAULT_MAX_LINE_LENGTH = 32_767;
const DEFAULT_MAX_COMMANDS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTF8_ENCODER = new TextEncoder();

const compareYzx = (left: Point, right: Point) =>
  left[1] - right[1] || left[2] - right[2] || left[0] - right[0];

const pointKey = (point: Point) => `${point[0]},${point[1]},${point[2]}`;

const sanitizeResourcePart = (value: string | undefined, fallback: string) => {
  const normalized = value?.normalize("NFKC").trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "");
  return normalized || fallback;
};

const encodeRelativeCoordinate = (value: number) => value === 0 ? "~" : `~${value}`;

const stateSuffix = (state: ResolvedBedrockBlockState) => {
  const entries = Object.entries(state.states)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return ` [${entries.map(([key, value]) => {
    const encoded = typeof value === "string" ? JSON.stringify(value) : String(value);
    return `${JSON.stringify(key)}=${encoded}`;
  }).join(",")}]`;
};

const stateCommand = (state: ProjectionBlockState) => {
  const bedrock = resolveBedrockBlockState(state);
  return `${bedrock.blockId}${stateSuffix(bedrock)}`;
};

const assertCommandLine = (line: string, maxLineLength: number) => {
  const length = UTF8_ENCODER.encode(line).length;
  if (length > maxLineLength) {
    throw new RangeError(`mcfunction line length ${length} exceeds limit ${maxLineLength}`);
  }
};

const segmentLength = (segment: CommandSegment) =>
  Math.abs(segment.end[0] - segment.start[0])
  + Math.abs(segment.end[1] - segment.start[1])
  + Math.abs(segment.end[2] - segment.start[2])
  + 1;

const decodeChunkPosition = (chunk: ProjectionChunk, index: number): Point => {
  const encoded = chunk.positions[index];
  if (encoded >= PROJECTION_CHUNK_SIZE ** 3) {
    throw new RangeError(`Projection chunk ${pointKey(chunk.chunk)} has an invalid local position`);
  }
  const x = encoded % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(encoded / PROJECTION_CHUNK_SIZE);
  const z = yz % PROJECTION_CHUNK_SIZE;
  const y = Math.floor(yz / PROJECTION_CHUNK_SIZE);
  return [
    chunk.chunk[0] * PROJECTION_CHUNK_SIZE + x,
    chunk.chunk[1] * PROJECTION_CHUNK_SIZE + y,
    chunk.chunk[2] * PROJECTION_CHUNK_SIZE + z,
  ];
};

const buildChunkSegments = (
  chunk: ProjectionChunk,
  minFillLength: number,
  paletteSize: number,
): CommandSegment[] => {
  const byPalette = new Map<number, Point[]>();
  for (let index = 0; index < chunk.positions.length; index += 1) {
    const paletteIndex = chunk.paletteIndices[index];
    if (paletteIndex >= paletteSize) {
      throw new RangeError(`Unknown projection palette index: ${paletteIndex}`);
    }
    const target = byPalette.get(paletteIndex) ?? [];
    target.push(decodeChunkPosition(chunk, index));
    byPalette.set(paletteIndex, target);
  }

  const segments: CommandSegment[] = [];
  for (const [paletteIndex, positions] of [...byPalette.entries()].sort(([a], [b]) => a - b)) {
    positions.sort(compareYzx);
    const remaining = new Set(positions.map(pointKey));
    for (const start of positions) {
      if (!remaining.has(pointKey(start))) continue;
      let bestAxis = -1;
      let bestLength = 1;
      for (let axis = 0; axis < 3; axis += 1) {
        let length = 1;
        const cursor = [...start] as Point;
        while (true) {
          cursor[axis] += 1;
          if (!remaining.has(pointKey(cursor))) break;
          length += 1;
        }
        if (length > bestLength) {
          bestLength = length;
          bestAxis = axis;
        }
      }

      const end = [...start] as Point;
      if (bestLength >= minFillLength && bestAxis >= 0) {
        end[bestAxis] += bestLength - 1;
        for (let offset = 0; offset < bestLength; offset += 1) {
          const consumed = [...start] as Point;
          consumed[bestAxis] += offset;
          remaining.delete(pointKey(consumed));
        }
      } else {
        remaining.delete(pointKey(start));
      }
      segments.push({ start: [...start], end, paletteIndex });
    }
  }
  return segments.sort((left, right) =>
    compareYzx(left.start, right.start) || left.paletteIndex - right.paletteIndex);
};

const commandForSegment = (
  segment: CommandSegment,
  anchor: Point,
  paletteCommands: readonly string[],
) => {
  const block = paletteCommands[segment.paletteIndex];
  if (!block) throw new RangeError(`Unknown projection palette index: ${segment.paletteIndex}`);
  const start = segment.start.map((value, axis) => value - anchor[axis]) as Point;
  if (segmentLength(segment) === 1) {
    return `setblock ${start.map(encodeRelativeCoordinate).join(" ")} ${block} replace`;
  }
  const end = segment.end.map((value, axis) => value - anchor[axis]) as Point;
  return `fill ${start.map(encodeRelativeCoordinate).join(" ")} ${end.map(encodeRelativeCoordinate).join(" ")} ${block} replace`;
};

const createUuid = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.every((value) => value === 0)) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const validateUuid = (value: string, label: string) => {
  if (!UUID_PATTERN.test(value)) throw new RangeError(`${label} must be a valid UUID`);
  return value;
};

const functionPath = (functionId: string) => `functions/${functionId}.mcfunction`;

const createFunctionFile = (
  functionId: string,
  commands: readonly string[],
): McfunctionFile => ({
  path: functionPath(functionId),
  functionId,
  content: `${commands.join("\n")}\n`,
  commandCount: commands.length,
});

const prepareGeneration = (
  document: ProjectionDocument,
  options: McfunctionExportOptions,
): McfunctionGenerationPlan => {
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot export an empty mcfunction pack");
  }
  if (!Number.isSafeInteger(document.blockCount) || document.blockCount < 0) {
    throw new RangeError("Projection block count must be a non-negative safe integer");
  }

  const namespace = sanitizeResourcePart(options.namespace, "mely");
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const maxCommands = options.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS;
  const minFillLength = options.minFillLength ?? 2;
  if (!Number.isSafeInteger(maxLineLength) || maxLineLength <= 0) {
    throw new RangeError("mcfunction maximum line length must be a positive integer");
  }
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 2) {
    throw new RangeError("mcfunction command limit must be at least 2");
  }
  if (!Number.isSafeInteger(minFillLength) || minFillLength < 2) {
    throw new RangeError("mcfunction fill threshold must be at least 2");
  }

  const chunks = [...document.chunks].sort((left, right) => compareYzx(left.chunk, right.chunk));
  const seenChunks = new Set<string>();
  let observedBlockCount = 0;
  for (const chunk of chunks) {
    const key = pointKey(chunk.chunk);
    if (seenChunks.has(key)) throw new RangeError(`Duplicate projection chunk: ${key}`);
    seenChunks.add(key);
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError(`Projection chunk ${key} has inconsistent buffers`);
    }
    observedBlockCount += chunk.positions.length;
  }
  if (observedBlockCount !== document.blockCount) {
    throw new RangeError(
      `Projection block count ${document.blockCount} does not match chunk data ${observedBlockCount}`,
    );
  }

  const headerUuid = validateUuid(options.headerUuid ?? createUuid(), "Behavior pack header UUID");
  const moduleUuid = validateUuid(options.moduleUuid ?? createUuid(), "Behavior pack module UUID");
  if (headerUuid === moduleUuid) throw new RangeError("Behavior pack UUIDs must be distinct");
  const manifest: McfunctionManifest = {
    format_version: 2,
    header: {
      name: options.packName?.normalize("NFKC").trim() || "MELY Projection",
      description: options.description?.normalize("NFKC").trim() || "Generated by MELY",
      uuid: headerUuid,
      version: [1, 0, 0],
      min_engine_version: options.minEngineVersion
        ? [...options.minEngineVersion]
        : [...DEFAULT_BEDROCK_VERSION.minEngineVersion],
    },
    modules: [{ type: "data", uuid: moduleUuid, version: [1, 0, 0] }],
  };
  return {
    document,
    chunks,
    namespace,
    anchor: [...document.bounds.min],
    paletteCommands: document.palette.map(stateCommand),
    maxLineLength,
    maxCommands,
    minFillLength,
    manifest,
    entryFunction: `${namespace}/load`,
  };
};

// Keep only one projection chunk and one leaf command part live while files are delivered.
const generateMcfunctionFiles = function* (
  plan: McfunctionGenerationPlan,
): Generator<McfunctionFile, McfunctionExportMetadata, void> {
  const leafIds: string[] = [];
  let commandCount = 0;
  let fillCount = 0;
  let setblockCount = 0;
  let functionCount = 0;

  for (const chunk of plan.chunks) {
    const segments = buildChunkSegments(
      chunk,
      plan.minFillLength,
      plan.paletteCommands.length,
    );
    const chunkName = chunk.chunk
      .map((value) => value < 0 ? `n${-value}` : `p${value}`)
      .join("_");
    let part = 0;
    let partCommands: string[] = [];

    for (const segment of segments) {
      const command = commandForSegment(segment, plan.anchor, plan.paletteCommands);
      assertCommandLine(command, plan.maxLineLength);
      if (command.startsWith("fill ")) fillCount += 1;
      else setblockCount += 1;
      commandCount += 1;
      partCommands.push(command);

      if (partCommands.length === plan.maxCommands) {
        const functionId = `${plan.namespace}/chunks/c_${chunkName}_${part.toString().padStart(4, "0")}`;
        const commands = partCommands;
        partCommands = [];
        part += 1;
        leafIds.push(functionId);
        functionCount += 1;
        yield createFunctionFile(functionId, commands);
      }
    }

    if (partCommands.length > 0) {
      const functionId = `${plan.namespace}/chunks/c_${chunkName}_${part.toString().padStart(4, "0")}`;
      const commands = partCommands;
      partCommands = [];
      leafIds.push(functionId);
      functionCount += 1;
      yield createFunctionFile(functionId, commands);
    }
  }

  let level = leafIds;
  let depth = 0;
  while (level.length > plan.maxCommands) {
    const next: string[] = [];
    for (let offset = 0; offset < level.length; offset += plan.maxCommands) {
      const functionId = `${plan.namespace}/dispatch/d${depth}_${Math.floor(offset / plan.maxCommands).toString().padStart(4, "0")}`;
      const commands = level.slice(offset, offset + plan.maxCommands)
        .map((target) => `function ${target}`);
      commands.forEach((command) => assertCommandLine(command, plan.maxLineLength));
      next.push(functionId);
      functionCount += 1;
      yield createFunctionFile(functionId, commands);
    }
    level = next;
    depth += 1;
  }

  const entryCommands = level.map((target) => `function ${target}`);
  entryCommands.forEach((command) => assertCommandLine(command, plan.maxLineLength));
  functionCount += 1;
  yield createFunctionFile(plan.entryFunction, entryCommands);

  return {
    manifest: plan.manifest,
    entryFunction: plan.entryFunction,
    summary: {
      blockCount: plan.document.blockCount,
      commandCount,
      fillCount,
      setblockCount,
      functionCount,
      maxLineLength: plan.maxLineLength,
      maxCommandsPerFunction: plan.maxCommands,
    },
  };
};

export const iterateMcfunctionBehaviorPackFiles = (
  document: ProjectionDocument,
  options: McfunctionExportOptions = {},
): Generator<McfunctionFile, McfunctionExportMetadata, void> =>
  generateMcfunctionFiles(prepareGeneration(document, options));

export async function* iterateMcfunctionBehaviorPackFilesAsync(
  document: ProjectionDocument,
  options: McfunctionExportOptions = {},
): AsyncGenerator<McfunctionFile, McfunctionExportMetadata, void> {
  const iterator = iterateMcfunctionBehaviorPackFiles(document, options);
  while (true) {
    const next = iterator.next();
    if (next.done === true) return next.value;
    yield next.value;
  }
}

export const streamMcfunctionBehaviorPack = async (
  document: ProjectionDocument,
  options: McfunctionExportOptions,
  onFile: McfunctionFileHandler,
): Promise<McfunctionExportMetadata> => {
  const iterator = iterateMcfunctionBehaviorPackFiles(document, options);
  while (true) {
    const next = iterator.next();
    if (next.done === true) return next.value;
    await onFile(next.value);
  }
};

export const createMcfunctionBehaviorPack = (
  document: ProjectionDocument,
  options: McfunctionExportOptions = {},
): McfunctionExport => {
  const iterator = iterateMcfunctionBehaviorPackFiles(document, options);
  const files: McfunctionFile[] = [];
  while (true) {
    const next = iterator.next();
    if (next.done === true) {
      return {
        ...next.value,
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
      };
    }
    files.push(next.value);
  }
};

export const createMcfunctionBehaviorPackZipStream = async (
  document: ProjectionDocument,
  sink: ZipChunkSink,
  options: McfunctionZipOptions = {},
): Promise<StreamedMcfunctionZip> => {
  const writer = createZipStreamWriter(sink, {
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });
  try {
    const metadata = await streamMcfunctionBehaviorPack(document, options, async (file) => {
      await writer.add(file.path, strToU8(file.content), true);
    });
    await writer.add(
      "manifest.json",
      strToU8(`${JSON.stringify(metadata.manifest, null, 2)}\n`),
      true,
    );
    return { ...metadata, archive: await writer.close() };
  } catch (error) {
    writer.abort();
    throw error;
  }
};

export const createMcfunctionBehaviorPackZip = async (
  document: ProjectionDocument,
  options: McfunctionZipOptions = {},
): Promise<McfunctionZip> => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const streamed = await createMcfunctionBehaviorPackZipStream(document, (chunk) => {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }, options);
  return {
    ...streamed,
    bytes: combineZipChunks(chunks, byteLength),
  };
};

export const createMcfunctionPack = createMcfunctionBehaviorPack;
