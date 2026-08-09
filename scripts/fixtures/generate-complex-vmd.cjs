const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");

const SIGNATURE = "Vocaloid Motion Data 0002";
const MODEL_NAME = "MELY PMD E2E";
const DEFAULT_OUTPUT = resolve(__dirname, "../../tests/fixtures/mely-complex-motion-e2e.vmd");

const fixedAscii = (value, length) => {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) throw new RangeError(`ASCII field exceeds ${length} bytes`);
  const bytes = Buffer.alloc(length);
  encoded.copy(bytes);
  return bytes;
};

const uint32 = (value) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

const float32Tuple = (values) => {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
};

const normalizedQuaternion = (values) => {
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length <= 1e-12) throw new RangeError("Invalid VMD quaternion");
  return values.map((value) => value / length);
};

const linearInterpolation = () => {
  const bytes = Buffer.alloc(64);
  for (let channel = 0; channel < 4; channel += 1) {
    bytes[channel] = 20;
    bytes[channel + 4] = 20;
    bytes[channel + 8] = 107;
    bytes[channel + 12] = 107;
  }
  return bytes;
};

const boneFrame = ({ name, frame, translation, rotation }) => Buffer.concat([
  fixedAscii(name, 15),
  uint32(frame),
  float32Tuple(translation),
  float32Tuple(normalizedQuaternion(rotation)),
  linearInterpolation(),
]);

const morphFrame = ({ name, frame, weight }) => Buffer.concat([
  fixedAscii(name, 15),
  uint32(frame),
  float32Tuple([weight]),
]);

const rotationZ = (degrees) => {
  const radians = degrees * Math.PI / 180;
  return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
};

const createComplexVmd = () => {
  const boneFrames = [
    { name: "root", frame: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "upper", frame: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "lower", frame: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "ik_goal", frame: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { name: "root", frame: 15, translation: [0.25, 0.1, 0], rotation: rotationZ(4) },
    { name: "upper", frame: 15, translation: [0, 0, 0], rotation: rotationZ(18) },
    { name: "lower", frame: 15, translation: [0, 0, 0], rotation: rotationZ(-12) },
    { name: "ik_goal", frame: 15, translation: [0.35, 0.15, 0.2], rotation: [0, 0, 0, 1] },
    { name: "root", frame: 30, translation: [0.55, 0.2, 0.1], rotation: rotationZ(8) },
    { name: "upper", frame: 30, translation: [0, 0, 0], rotation: rotationZ(36) },
    { name: "lower", frame: 30, translation: [0, 0, 0], rotation: rotationZ(-24) },
    { name: "ik_goal", frame: 30, translation: [0.75, 0.35, 0.35], rotation: [0, 0, 0, 1] },
  ];
  const morphFrames = [
    { name: "smile", frame: 0, weight: 0 },
    { name: "smile", frame: 15, weight: 0.5 },
    { name: "smile", frame: 30, weight: 1 },
  ];
  return Uint8Array.from(Buffer.concat([
    fixedAscii(SIGNATURE, 30),
    fixedAscii(MODEL_NAME, 20),
    uint32(boneFrames.length),
    ...boneFrames.map(boneFrame),
    uint32(morphFrames.length),
    ...morphFrames.map(morphFrame),
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(0),
  ]));
};

const writeComplexVmd = async (outputPath = DEFAULT_OUTPUT) => {
  const resolved = resolve(outputPath);
  const bytes = createComplexVmd();
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, bytes);
  return { outputPath: resolved, byteLength: bytes.byteLength };
};

if (require.main === module) {
  writeComplexVmd(process.argv[2] || DEFAULT_OUTPUT).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_OUTPUT,
  MODEL_NAME,
  SIGNATURE,
  createComplexVmd,
  writeComplexVmd,
};
