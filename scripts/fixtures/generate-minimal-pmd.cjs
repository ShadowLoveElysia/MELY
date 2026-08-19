const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const DEFAULT_OUTPUT = resolve(__dirname, "../../tests/fixtures/mely-input-e2e.pmd");
const DEFAULT_MODEL_PART_SELECTION_OUTPUT = resolve(
  __dirname,
  "../../tests/fixtures/mely-model-part-selection-e2e.pmd",
);

const MODEL_PART_SELECTION_PROFILE = Object.freeze({
  materialCount: 2,
  targetMaterialIndex: 0,
  preservedMaterialIndex: 1,
  clickRois: Object.freeze({
    0: Object.freeze({ xMin: 0.28, xMax: 0.5, yMin: 0.22, yMax: 0.78 }),
    1: Object.freeze({ xMin: 0.5, xMax: 0.72, yMin: 0.22, yMax: 0.78 }),
  }),
  validationRois: Object.freeze({
    target: Object.freeze({ xMin: 0.28, xMax: 0.5, yMin: 0.22, yMax: 0.78 }),
    targetInterior: Object.freeze({ xMin: 0.36, xMax: 0.41, yMin: 0.6, yMax: 0.75 }),
    preserved: Object.freeze({ xMin: 0.51, xMax: 0.56, yMin: 0.6, yMax: 0.75 }),
  }),
});

const fixedAscii = (value, length) => {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) throw new RangeError(`ASCII field exceeds ${length} bytes`);
  const bytes = Buffer.alloc(length);
  encoded.copy(bytes);
  return bytes;
};

const uint8 = (value) => Buffer.from([value]);

const uint16 = (value) => {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
};

const uint32 = (value) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

const float32 = (value) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value, 0);
  return bytes;
};

const float32Tuple = (values) => Buffer.concat(values.map(float32));

const prismGeometry = (scale = 1, xOffset = 0, correctedWinding = false) => {
  const levels = [0, 1, 2, 3];
  const corners = [
    [-0.34, -0.22],
    [0.34, -0.22],
    [0.34, 0.22],
    [-0.34, 0.22],
  ];
  const vertices = levels.flatMap((y, level) => corners.map(([x, z], corner) => {
    const length = Math.hypot(x, z) || 1;
    const primaryBone = Math.min(3, level);
    const secondaryBone = Math.max(0, primaryBone - 1);
    return {
      position: [x * scale + xOffset, y * scale, z * scale],
      normal: [x / length, 0, z / length],
      uv: [corner / 3, level / 3],
      bone0: primaryBone,
      bone1: secondaryBone,
      weight: level === 0 ? 100 : 82,
    };
  }));
  const indices = [];
  for (let level = 0; level < levels.length - 1; level += 1) {
    const lower = level * 4;
    const upper = (level + 1) * 4;
    for (let side = 0; side < 4; side += 1) {
      const next = (side + 1) % 4;
      if (correctedWinding) {
        indices.push(lower + side, upper + side, lower + next);
        indices.push(lower + next, upper + side, upper + next);
      } else {
        indices.push(lower + side, lower + next, upper + side);
        indices.push(lower + next, upper + next, upper + side);
      }
    }
  }
  if (correctedWinding) {
    indices.push(0, 1, 2, 0, 2, 3);
    indices.push(12, 14, 13, 12, 15, 14);
  } else {
    indices.push(0, 2, 1, 0, 3, 2);
    indices.push(12, 13, 14, 12, 14, 15);
  }
  return { vertices, indices };
};

const twoMaterialGeometry = (scale) => {
  // 两个独立棱柱共用一套骨骼，便于同时验证 MultiMaterial 子网格隐藏与拾取。
  const left = prismGeometry(scale, -0.52 * scale, true);
  const right = prismGeometry(scale, 0.52 * scale, true);
  const rightVertexOffset = left.vertices.length;
  return {
    vertices: [...left.vertices, ...right.vertices],
    indices: [...left.indices, ...right.indices.map((index) => index + rightVertexOffset)],
    materialIndexCounts: [left.indices.length, right.indices.length],
  };
};

const vertexRecord = (vertex) => Buffer.concat([
  float32Tuple(vertex.position),
  float32Tuple(vertex.normal),
  float32Tuple(vertex.uv),
  uint16(vertex.bone0),
  uint16(vertex.bone1),
  uint8(vertex.weight),
  uint8(0),
]);

const materialRecord = (indexCount, textureName, options = {}) => Buffer.concat([
  float32Tuple(options.diffuse || [0.92, 0.64, 0.78, 1]),
  float32(options.shininess ?? 8),
  float32Tuple(options.specular || [0.2, 0.2, 0.2]),
  float32Tuple(options.ambient || [0.34, 0.18, 0.26]),
  uint8(options.toonIndex ?? 255),
  uint8(options.edgeFlag ?? 0),
  uint32(indexCount),
  fixedAscii(textureName, 20),
]);

const boneRecord = ({ name, parent, tail, type, ikIndex, position }) => Buffer.concat([
  fixedAscii(name, 20),
  uint16(parent < 0 ? 0xffff : parent),
  uint16(tail < 0 ? 0xffff : tail),
  uint8(type),
  uint16(ikIndex < 0 ? 0xffff : ikIndex),
  float32Tuple(position),
]);

const morphRecord = ({ name, type, entries }) => Buffer.concat([
  fixedAscii(name, 20),
  uint32(entries.length),
  uint8(type),
  ...entries.map((entry) => Buffer.concat([
    uint32(entry.index),
    float32Tuple(entry.position),
  ])),
]);

const createMinimalPmd = (options = {}) => {
  const name = options.name || "MELY Character";
  const textureName = options.textureName || "";
  const scale = Number.isFinite(options.scale) ? options.scale : 1;
  const includeMorph = options.includeMorph !== false;
  const includeIk = options.includeIk !== false;
  const materialCount = options.materialCount ?? 1;
  if (materialCount !== 1 && materialCount !== 2) {
    throw new RangeError("materialCount must be either 1 or 2");
  }
  const geometry = materialCount === 2 ? twoMaterialGeometry(scale) : prismGeometry(scale);
  const { vertices, indices } = geometry;
  const materialIndexCounts = materialCount === 2
    ? geometry.materialIndexCounts
    : [indices.length];
  const bones = [
    { name: "root", parent: -1, tail: 1, type: 1, ikIndex: -1, position: [0, 0, 0] },
    { name: "upper", parent: 0, tail: 2, type: 0, ikIndex: -1, position: [0, scale, 0] },
    { name: "lower", parent: 1, tail: 3, type: 0, ikIndex: -1, position: [0, scale * 2, 0] },
    { name: "effector", parent: 2, tail: -1, type: 0, ikIndex: -1, position: [0, scale * 3, 0] },
    { name: "ik_goal", parent: 0, tail: 3, type: 2, ikIndex: -1, position: [scale * 0.85, scale * 2.7, 0] },
  ];
  const topVertexIndices = materialCount === 2
    ? [12, 13, 14, 15, 28, 29, 30, 31]
    : [12, 13, 14, 15];
  const baseEntries = topVertexIndices.map((vertexIndex) => ({
    index: vertexIndex,
    position: vertices[vertexIndex].position,
  }));
  const morphs = includeMorph ? [
    { name: "base", type: 0, entries: baseEntries },
    {
      name: "smile",
      type: 1,
      entries: baseEntries.map((_entry, index) => ({
        index,
        position: [index % 4 < 2 ? -scale * 0.42 : scale * 0.42, scale * 0.12, 0],
      })),
    },
  ] : [];
  const activeBones = includeIk ? bones : bones.slice(0, 4);
  const ik = includeIk ? Buffer.concat([
    uint16(1),
    uint16(4),
    uint16(3),
    uint8(2),
    uint16(40),
    float32(0.5),
    uint16(2),
    uint16(1),
  ]) : uint16(0);

  return Uint8Array.from(Buffer.concat([
    fixedAscii("Pmd", 3),
    float32(1),
    fixedAscii(name, 20),
    fixedAscii("MELY PMD input and animation fixture", 256),
    uint32(vertices.length),
    ...vertices.map(vertexRecord),
    uint32(indices.length),
    ...indices.map(uint16),
    uint32(materialCount),
    ...(materialCount === 2 ? [
      materialRecord(materialIndexCounts[0], textureName, {
        diffuse: [0.96, 0.12, 0.2, 1],
        ambient: [0.42, 0.035, 0.055],
      }),
      materialRecord(materialIndexCounts[1], textureName, {
        diffuse: [0.06, 0.42, 0.98, 1],
        ambient: [0.018, 0.12, 0.44],
      }),
    ] : [materialRecord(indices.length, textureName)]),
    uint16(activeBones.length),
    ...activeBones.map(boneRecord),
    ik,
    uint16(morphs.length),
    ...morphs.map(morphRecord),
    uint8(includeMorph ? 1 : 0),
    ...(includeMorph ? [uint16(1)] : []),
    uint8(1),
    fixedAscii("main", 50),
    uint32(activeBones.length),
    ...activeBones.flatMap((_bone, index) => [uint16(index), uint8(1)]),
    uint8(0),
    ...Array.from({ length: 10 }, () => fixedAscii("", 100)),
    uint32(0),
    uint32(0),
  ]));
};

const createModelPartSelectionPmd = (options = {}) => createMinimalPmd({
  name: "MELY Part Select",
  includeMorph: true,
  includeIk: true,
  ...options,
  materialCount: 2,
});

const writeMinimalPmd = async (outputPath = DEFAULT_OUTPUT, options = {}) => {
  const resolved = resolve(outputPath);
  const bytes = createMinimalPmd(options);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, bytes);
  return { outputPath: resolved, byteLength: bytes.byteLength };
};

const writeModelPartSelectionPmd = async (
  outputPath = DEFAULT_MODEL_PART_SELECTION_OUTPUT,
  options = {},
) => {
  const resolved = resolve(outputPath);
  const bytes = createModelPartSelectionPmd(options);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, bytes);
  return { outputPath: resolved, byteLength: bytes.byteLength };
};

const writePmdFixtureSet = async (outputDirectory) => {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const character = await writeMinimalPmd(join(directory, "character.pmd"), {
    name: "MELY Character",
    textureName: "missing.png",
    includeMorph: true,
    includeIk: true,
  });
  const accessory = await writeMinimalPmd(join(directory, "accessory.pmd"), {
    name: "MELY Accessory",
    scale: 0.55,
    includeMorph: false,
    includeIk: false,
  });
  return { directory, character, accessory };
};

if (require.main === module) {
  writeMinimalPmd(process.argv[2] || DEFAULT_OUTPUT).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_OUTPUT,
  DEFAULT_MODEL_PART_SELECTION_OUTPUT,
  MODEL_PART_SELECTION_PROFILE,
  createMinimalPmd,
  createModelPartSelectionPmd,
  writeMinimalPmd,
  writeModelPartSelectionPmd,
  writePmdFixtureSet,
};
