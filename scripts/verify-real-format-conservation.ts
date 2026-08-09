import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gunzipSync, strFromU8, unzipSync } from "fflate";
import * as nbt from "prismarine-nbt";
import { createExportBundleAsync } from "../src/core/exportBundle";
import { createLitematicFromDocument } from "../src/core/litematic";
import { createMcfunctionBehaviorPackZip } from "../src/core/mcfunction";
import { createMcstructure, resolveBedrockBlockState } from "../src/core/mcstructure";
import {
  createProjectionDocument,
  splitProjectionViews,
} from "../src/core/projectionDocument";
import { createProjectionViewContentHash } from "../src/core/projectionContentHash";
import { createSchematic } from "../src/core/schematic";
import type {
  ProjectionBlock,
  ProjectionBlockState,
  ProjectionDocument,
} from "../src/types";

type Point = [number, number, number];
type StateMap = Map<string, string>;

const projectRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  process.env.MELY_FORMAT_SOURCE
    ?? join(projectRoot, "test-generation-solid-balanced.litematica"),
);
const outputDirectory = resolve(
  process.env.MELY_FORMAT_OUTPUT
    ?? join(projectRoot, "release-validation", "real-format-conservation"),
);
const reportPath = resolve(
  process.env.MELY_FORMAT_REPORT ?? join(outputDirectory, "report.json"),
);

const pointKey = (point: readonly number[]) => point.join(",");

const stateKey = (blockId: string, properties: Record<string, unknown> = {}) => (
  `${blockId}|${Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",")}`
);

const javaStateKey = (state: ProjectionBlockState) => stateKey(
  state.blockId,
  state.properties,
);

const bedrockStateKey = (state: ProjectionBlockState) => {
  const resolved = resolveBedrockBlockState(state);
  return stateKey(resolved.blockId, resolved.states);
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const addBlock = (
  target: StateMap,
  position: Point,
  state: string,
  source: string,
) => {
  const key = pointKey(position);
  if (target.has(key)) throw new Error(`${source} contains a duplicate block at ${key}`);
  target.set(key, state);
};

const unpackPrismarineLong = (value: [number, number]) => (
  (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0)
);

const unpackPaletteIndex = (
  longs: Array<[number, number]>,
  index: number,
  bitsPerBlock: number,
) => {
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const bitOffset = index * bitsPerBlock;
  const longIndex = Math.floor(bitOffset / 64);
  const innerOffset = bitOffset & 63;
  const first = unpackPrismarineLong(longs[longIndex]);
  const available = 64 - innerOffset;
  if (available >= bitsPerBlock) {
    return Number((first >> BigInt(innerOffset)) & mask);
  }
  const second = unpackPrismarineLong(longs[longIndex + 1]);
  return Number(((first >> BigInt(innerOffset)) | (second << BigInt(available))) & mask);
};

interface DecodedLitematic {
  map: StateMap;
  root: any;
}

const decodeLitematic = (
  bytes: Uint8Array,
  offset: Point = [0, 0, 0],
): DecodedLitematic => {
  const parsed = nbt.parseUncompressed(Buffer.from(gunzipSync(bytes)), "big");
  const root = nbt.simplify(parsed) as any;
  const map: StateMap = new Map();
  for (const [regionName, region] of Object.entries<any>(root.Regions)) {
    const position: Point = [region.Position.x, region.Position.y, region.Position.z];
    const size: Point = [region.Size.x, region.Size.y, region.Size.z];
    if (size.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)) {
      throw new Error(`Region ${regionName} has unsupported dimensions ${size.join("x")}`);
    }
    const palette = region.BlockStatePalette as Array<{
      Name: string;
      Properties?: Record<string, string>;
    }>;
    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))));
    const volume = size[0] * size[1] * size[2];
    for (let linearIndex = 0; linearIndex < volume; linearIndex += 1) {
      const paletteIndex = unpackPaletteIndex(region.BlockStates, linearIndex, bitsPerBlock);
      if (paletteIndex === 0) continue;
      const state = palette[paletteIndex];
      if (!state) throw new Error(`Region ${regionName} references palette ${paletteIndex}`);
      const x = linearIndex % size[0];
      const yz = Math.floor(linearIndex / size[0]);
      const z = yz % size[2];
      const y = Math.floor(yz / size[2]);
      addBlock(map, [
        position[0] + x + offset[0],
        position[1] + y + offset[1],
        position[2] + z + offset[2],
      ], stateKey(state.Name, state.Properties), `Litematica region ${regionName}`);
    }
  }
  return { map, root };
};

const parseJavaState = (serialized: string): ProjectionBlockState => {
  const bracket = serialized.indexOf("[");
  if (bracket < 0) return { blockId: serialized };
  const blockId = serialized.slice(0, bracket);
  const body = serialized.slice(bracket + 1, -1);
  const properties = Object.fromEntries(body.split(",").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid Java block state ${serialized}`);
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return { blockId, properties };
};

const projectionFromLitematic = (bytes: Uint8Array): ProjectionDocument => {
  const decoded = decodeLitematic(bytes);
  const palette: ProjectionBlockState[] = [];
  const paletteIndices = new Map<string, number>();
  const blocks: ProjectionBlock[] = [];
  for (const [positionKey, serialized] of decoded.map) {
    let paletteIndex = paletteIndices.get(serialized);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      paletteIndices.set(serialized, paletteIndex);
      const separator = serialized.indexOf("|");
      const blockId = serialized.slice(0, separator);
      const properties = Object.fromEntries(
        serialized.slice(separator + 1).split(",").filter(Boolean).map((entry) => {
          const equals = entry.indexOf("=");
          return [entry.slice(0, equals), entry.slice(equals + 1)];
        }),
      );
      palette.push({ blockId, ...(Object.keys(properties).length ? { properties } : {}) });
    }
    blocks.push({
      position: positionKey.split(",").map(Number) as Point,
      paletteIndex,
    });
  }
  return createProjectionDocument(blocks, palette, {
    edition: "java",
    minecraftVersion: "1.20.1",
    metadata: {
      generator: "MELY",
      source: basename(sourcePath),
      audit: "real-format-conservation",
    },
  });
};

const sourceStateMap = (
  document: ProjectionDocument,
  convertState: (state: ProjectionBlockState) => string,
) => {
  const map: StateMap = new Map();
  const min = document.bounds?.min ?? [0, 0, 0];
  for (const chunk of document.chunks) {
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const encoded = chunk.positions[index];
      const x = encoded % 32;
      const yz = Math.floor(encoded / 32);
      const z = yz % 32;
      const y = Math.floor(yz / 32);
      const position: Point = [
        chunk.chunk[0] * 32 + x - min[0],
        chunk.chunk[1] * 32 + y - min[1],
        chunk.chunk[2] * 32 + z - min[2],
      ];
      const state = document.palette[chunk.paletteIndices[index]];
      if (!state) throw new Error(`Source references palette ${chunk.paletteIndices[index]}`);
      addBlock(map, position, convertState(state), "ProjectionDocument");
    }
  }
  return map;
};

const decodeVarInt = (bytes: Uint8Array, cursor: number) => {
  let value = 0;
  let shift = 0;
  let next = cursor;
  while (true) {
    const byte = bytes[next++];
    if (byte === undefined) throw new Error("Schematic VarInt ended unexpectedly");
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next };
    shift += 7;
    if (shift >= 35) throw new Error("Schematic VarInt exceeds 5 bytes");
  }
};

const decodeSchematic = (bytes: Uint8Array) => {
  const parsed = nbt.parseUncompressed(Buffer.from(gunzipSync(bytes)), "big");
  const root = nbt.simplify(parsed) as any;
  const dimensions: Point = [root.Width, root.Height, root.Length];
  const offset: Point = [...root.Offset];
  const palette = new Map<number, ProjectionBlockState>();
  for (const [serialized, index] of Object.entries<number>(root.Blocks.Palette)) {
    palette.set(index, parseJavaState(serialized));
  }
  const data = Uint8Array.from(root.Blocks.Data, (value: number) => value & 0xff);
  const volume = dimensions[0] * dimensions[1] * dimensions[2];
  const map: StateMap = new Map();
  let cursor = 0;
  for (let linearIndex = 0; linearIndex < volume; linearIndex += 1) {
    const decoded = decodeVarInt(data, cursor);
    cursor = decoded.next;
    if (decoded.value === 0) continue;
    const state = palette.get(decoded.value);
    if (!state) throw new Error(`Schematic references palette ${decoded.value}`);
    const x = linearIndex % dimensions[0];
    const yz = Math.floor(linearIndex / dimensions[0]);
    const z = yz % dimensions[2];
    const y = Math.floor(yz / dimensions[2]);
    addBlock(map, [x + offset[0], y + offset[1], z + offset[2]], javaStateKey(state), "Schematic");
  }
  assert.equal(cursor, data.length, "Schematic BlockData has trailing bytes");
  return { map, root };
};

const decodeMcstructure = (bytes: Uint8Array) => {
  const parsed = nbt.parseUncompressed(Buffer.from(bytes), "little");
  const root = nbt.simplify(parsed) as any;
  const dimensions: Point = [...root.size];
  const origin: Point = [...root.structure_world_origin];
  const indices = root.structure.block_indices[0] as number[];
  const palette = root.structure.palette.default.block_palette as Array<{
    name: string;
    states: Record<string, unknown>;
  }>;
  const map: StateMap = new Map();
  indices.forEach((paletteIndex, linearIndex) => {
    if (paletteIndex < 0) return;
    const state = palette[paletteIndex];
    if (!state) throw new Error(`mcstructure references palette ${paletteIndex}`);
    const z = linearIndex % dimensions[2];
    const xy = Math.floor(linearIndex / dimensions[2]);
    const y = xy % dimensions[1];
    const x = Math.floor(xy / dimensions[1]);
    addBlock(map, [x + origin[0], y + origin[1], z + origin[2]], stateKey(state.name, state.states), "mcstructure");
  });
  return { map, root };
};

const relativeCoordinate = (token: string) => {
  if (token === "~") return 0;
  if (!token.startsWith("~")) throw new Error(`mcfunction uses an absolute coordinate: ${token}`);
  const value = Number(token.slice(1));
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid mcfunction coordinate ${token}`);
  return value;
};

const parseBedrockCommandState = (tokens: string[], stateIndex: number) => {
  const blockId = tokens[stateIndex];
  const encodedStates = tokens[stateIndex + 1]?.startsWith("[") ? tokens[stateIndex + 1] : "";
  const states: Record<string, unknown> = {};
  if (encodedStates) {
    const body = encodedStates.slice(1, -1);
    for (const entry of body.split(",").filter(Boolean)) {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid mcfunction state ${encodedStates}`);
      const key = JSON.parse(entry.slice(0, separator)) as string;
      const rawValue = entry.slice(separator + 1);
      states[key] = JSON.parse(rawValue) as unknown;
    }
  }
  return stateKey(blockId, states);
};

const decodeMcfunction = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  const map: StateMap = new Map();
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".mcfunction") || !path.includes("/chunks/")) continue;
    for (const line of strFromU8(content).trim().split("\n").filter(Boolean)) {
      const tokens = line.trim().split(/\s+/);
      if (tokens[0] === "setblock") {
        const position = tokens.slice(1, 4).map(relativeCoordinate) as Point;
        addBlock(map, position, parseBedrockCommandState(tokens, 4), `mcfunction ${path}`);
        continue;
      }
      if (tokens[0] !== "fill") throw new Error(`Unexpected chunk command: ${line}`);
      const start = tokens.slice(1, 4).map(relativeCoordinate) as Point;
      const end = tokens.slice(4, 7).map(relativeCoordinate) as Point;
      const state = parseBedrockCommandState(tokens, 7);
      for (let x = Math.min(start[0], end[0]); x <= Math.max(start[0], end[0]); x += 1) {
        for (let y = Math.min(start[1], end[1]); y <= Math.max(start[1], end[1]); y += 1) {
          for (let z = Math.min(start[2], end[2]); z <= Math.max(start[2], end[2]); z += 1) {
            addBlock(map, [x, y, z], state, `mcfunction ${path}`);
          }
        }
      }
    }
  }
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  return { map, manifest, files };
};

const compareMaps = (expected: StateMap, actual: StateMap, format: string) => {
  assert.equal(actual.size, expected.size, `${format} block count differs`);
  let coordinateMismatches = 0;
  let stateMismatches = 0;
  const samples: Array<{ position: string; expected?: string; actual?: string }> = [];
  for (const [position, state] of expected) {
    const observed = actual.get(position);
    if (observed === undefined) {
      coordinateMismatches += 1;
      if (samples.length < 8) samples.push({ position, expected: state });
    } else if (observed !== state) {
      stateMismatches += 1;
      if (samples.length < 8) samples.push({ position, expected: state, actual: observed });
    }
  }
  for (const [position, state] of actual) {
    if (expected.has(position)) continue;
    coordinateMismatches += 1;
    if (samples.length < 8) samples.push({ position, actual: state });
  }
  assert.equal(coordinateMismatches, 0, `${format} coordinate mismatches: ${JSON.stringify(samples)}`);
  assert.equal(stateMismatches, 0, `${format} state mismatches: ${JSON.stringify(samples)}`);
  return { blockCount: actual.size, coordinateMismatches, stateMismatches };
};

const mapDigest = (map: StateMap) => sha256(new TextEncoder().encode(
  [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([position, state]) => `${position}|${state}`)
    .join("\n"),
));

const run = async () => {
  await mkdir(outputDirectory, { recursive: true });
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  const document = projectionFromLitematic(sourceBytes);
  if (!document.bounds) throw new Error("The source projection is empty");
  const expectedJava = sourceStateMap(document, javaStateKey);
  const expectedBedrock = sourceStateMap(document, bedrockStateKey);
  const report: any = {
    generatedAt: new Date().toISOString(),
    source: {
      path: sourcePath,
      byteLength: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      blockCount: document.blockCount,
      dimensions: document.bounds.dimensions,
      paletteSize: document.palette.length,
      javaDigest: mapDigest(expectedJava),
      bedrockDigest: mapDigest(expectedBedrock),
    },
    formats: {},
    assertions: {},
  };

  const litematic = createLitematicFromDocument(document, {
    name: "MELY Real Format Audit",
    author: "MELY",
    timestamp: 1,
    regionMaxSize: 32,
  });
  await writeFile(join(outputDirectory, "real-format-audit.litematica"), litematic.bytes);
  const decodedLitematic = decodeLitematic(litematic.bytes);
  report.formats.litematic = {
    byteLength: litematic.bytes.byteLength,
    sha256: sha256(litematic.bytes),
    version: decodedLitematic.root.Version,
    subVersion: decodedLitematic.root.SubVersion,
    dataVersion: decodedLitematic.root.MinecraftDataVersion,
    regionCount: decodedLitematic.root.Metadata.RegionCount,
    ...compareMaps(expectedJava, decodedLitematic.map, "Litematica"),
  };

  const bundle = await createExportBundleAsync(document, {
    name: "MELY Real Format Audit",
    guideLocale: "en-US",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
  });
  await writeFile(join(outputDirectory, "real-format-audit-bundle.zip"), bundle.bytes);
  const bundleFiles = unzipSync(bundle.bytes);
  const manifest = JSON.parse(strFromU8(bundleFiles["bundle.json"]));
  const overall = decodeLitematic(bundleFiles[manifest.litematic.overall]);
  const partUnion: StateMap = new Map();
  for (const part of manifest.parts) {
    const decodedPart = decodeLitematic(bundleFiles[part.files.litematic], part.relativeOffset);
    for (const [position, state] of decodedPart.map) {
      addBlock(
        partUnion,
        position.split(",").map(Number) as Point,
        state,
        `Bundle part ${part.id}`,
      );
    }
  }
  const views = splitProjectionViews(document, [32, 32, 32]);
  assert.equal(manifest.parts.length, views.length);
  manifest.parts.forEach((part: any, index: number) => {
    assert.equal(part.buildOrder, index + 1, `Bundle part ${part.id} build order differs`);
    assert.equal(
      part.contentHash,
      createProjectionViewContentHash(document, views[index]),
      `Bundle part ${part.id} content hash differs`,
    );
  });
  const materialPlan = JSON.parse(strFromU8(bundleFiles[manifest.guides.materials]));
  report.formats.bundle = {
    byteLength: bundle.bytes.byteLength,
    sha256: sha256(bundle.bytes),
    fileCount: Object.keys(bundleFiles).length,
    partCount: manifest.parts.length,
    defaultOptionalFormatsAbsent: !Object.keys(bundleFiles).some((path) => (
      path.endsWith(".schem")
      || path.endsWith(".mcstructure")
      || path.endsWith(".mcfunction")
    )),
    materialCount: materialPlan.totalBlocks,
    overall: compareMaps(expectedJava, overall.map, "Bundle overall Litematica"),
    parts: compareMaps(expectedJava, partUnion, "Bundle part union"),
    validBuildOrderAndHashes: true,
  };
  assert.equal(materialPlan.totalBlocks, document.blockCount);
  assert.equal(report.formats.bundle.defaultOptionalFormatsAbsent, true);

  const schematic = createSchematic(document, {
    name: "MELY Real Format Audit",
    author: "MELY",
  });
  await writeFile(join(outputDirectory, "real-format-audit.schem"), schematic.bytes);
  const decodedSchematic = decodeSchematic(schematic.bytes);
  report.formats.schematic = {
    byteLength: schematic.bytes.byteLength,
    sha256: sha256(schematic.bytes),
    version: decodedSchematic.root.Version,
    dataVersion: decodedSchematic.root.DataVersion,
    ...compareMaps(expectedJava, decodedSchematic.map, "Schematic"),
  };

  const mcstructure = createMcstructure(document);
  await writeFile(join(outputDirectory, "real-format-audit.mcstructure"), mcstructure.bytes);
  const decodedMcstructure = decodeMcstructure(mcstructure.bytes);
  report.formats.mcstructure = {
    byteLength: mcstructure.bytes.byteLength,
    sha256: sha256(mcstructure.bytes),
    formatVersion: decodedMcstructure.root.format_version,
    blockVersion: mcstructure.summary.blockVersion,
    ...compareMaps(expectedBedrock, decodedMcstructure.map, "mcstructure"),
  };

  const mcfunction = await createMcfunctionBehaviorPackZip(document, {
    namespace: "mely_real_format_audit",
    packName: "MELY Real Format Audit",
    headerUuid: "11111111-1111-4111-8111-111111111111",
    moduleUuid: "22222222-2222-4222-8222-222222222222",
  });
  await writeFile(join(outputDirectory, "real-format-audit-mcfunction.zip"), mcfunction.bytes);
  const decodedMcfunction = decodeMcfunction(mcfunction.bytes);
  report.formats.mcfunction = {
    byteLength: mcfunction.bytes.byteLength,
    sha256: sha256(mcfunction.bytes),
    minEngineVersion: decodedMcfunction.manifest.header.min_engine_version,
    functionCount: Object.keys(decodedMcfunction.files).filter((path) => path.endsWith(".mcfunction")).length,
    commandCount: mcfunction.summary.commandCount,
    fillCount: mcfunction.summary.fillCount,
    setblockCount: mcfunction.summary.setblockCount,
    ...compareMaps(expectedBedrock, decodedMcfunction.map, "mcfunction"),
  };

  report.assertions = {
    realSourceHasBlocks: document.blockCount > 100_000,
    sourceHeightIsApproximately320: document.bounds.dimensions[1] >= 300,
    litematicaJavaConserved: report.formats.litematic.coordinateMismatches === 0
      && report.formats.litematic.stateMismatches === 0,
    bundleJavaConserved: report.formats.bundle.overall.coordinateMismatches === 0
      && report.formats.bundle.parts.coordinateMismatches === 0,
    schematicJavaConserved: report.formats.schematic.coordinateMismatches === 0
      && report.formats.schematic.stateMismatches === 0,
    mcstructureBedrockConserved: report.formats.mcstructure.coordinateMismatches === 0
      && report.formats.mcstructure.stateMismatches === 0,
    mcfunctionBedrockConserved: report.formats.mcfunction.coordinateMismatches === 0
      && report.formats.mcfunction.stateMismatches === 0,
    javaVersionCorrect: report.formats.litematic.version === 6
      && report.formats.litematic.subVersion === 1
      && report.formats.litematic.dataVersion === 3465
      && report.formats.schematic.version === 3
      && report.formats.schematic.dataVersion === 3465,
    bedrockVersionCorrect: JSON.stringify(report.formats.mcfunction.minEngineVersion) === "[1,20,10]",
    defaultBundleIsLightweight: report.formats.bundle.defaultOptionalFormatsAbsent,
    bundleIntegrityMetadataValid: report.formats.bundle.validBuildOrderAndHashes,
  };
  if (!Object.values(report.assertions).every(Boolean)) {
    throw new Error(`Format conservation assertions failed: ${JSON.stringify(report.assertions)}`);
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, assertions: report.assertions }, null, 2)}\n`);
};

run().catch(async (error) => {
  const failure = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  console.error(error);
  process.exitCode = 1;
});
