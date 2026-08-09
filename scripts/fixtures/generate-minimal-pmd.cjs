const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const DEFAULT_OUTPUT = resolve(__dirname, "../../tests/fixtures/mely-input-e2e.pmd");

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

const prismGeometry = (scale = 1) => {
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
      position: [x * scale, y * scale, z * scale],
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
      indices.push(lower + side, lower + next, upper + side);
      indices.push(lower + next, upper + next, upper + side);
    }
  }
  indices.push(0, 2, 1, 0, 3, 2);
  indices.push(12, 13, 14, 12, 14, 15);
  return { vertices, indices };
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

const materialRecord = (indexCount, textureName) => Buffer.concat([
  float32Tuple([0.92, 0.64, 0.78, 1]),
  float32(8),
  float32Tuple([0.2, 0.2, 0.2]),
  float32Tuple([0.34, 0.18, 0.26]),
  uint8(255),
  uint8(0),
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
  const { vertices, indices } = prismGeometry(scale);
  const bones = [
    { name: "root", parent: -1, tail: 1, type: 1, ikIndex: -1, position: [0, 0, 0] },
    { name: "upper", parent: 0, tail: 2, type: 0, ikIndex: -1, position: [0, scale, 0] },
    { name: "lower", parent: 1, tail: 3, type: 0, ikIndex: -1, position: [0, scale * 2, 0] },
    { name: "effector", parent: 2, tail: -1, type: 0, ikIndex: -1, position: [0, scale * 3, 0] },
    { name: "ik_goal", parent: 0, tail: 3, type: 2, ikIndex: -1, position: [scale * 0.85, scale * 2.7, 0] },
  ];
  const baseEntries = [12, 13, 14, 15].map((vertexIndex) => ({
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
        position: [index < 2 ? -scale * 0.42 : scale * 0.42, scale * 0.12, 0],
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
    uint32(1),
    materialRecord(indices.length, textureName),
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
    uint32(0),
    uint32(0),
  ]));
};

const writeMinimalPmd = async (outputPath = DEFAULT_OUTPUT, options = {}) => {
  const resolved = resolve(outputPath);
  const bytes = createMinimalPmd(options);
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
  createMinimalPmd,
  writeMinimalPmd,
  writePmdFixtureSet,
};
