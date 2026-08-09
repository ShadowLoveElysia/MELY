const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");

const SIGNATURE = "Vocaloid Motion Data 0002";
const MODEL_NAME = "MELY E2E";
const DEFAULT_OUTPUT = resolve(__dirname, "../../tests/fixtures/mely-motion-e2e.vmd");

const shiftJisNames = new Map([
  ["センター", Uint8Array.from([0x83, 0x5a, 0x83, 0x93, 0x83, 0x5e, 0x81, 0x5b])],
  ["上半身", Uint8Array.from([0x8f, 0xe3, 0x94, 0xbc, 0x90, 0x67])],
]);

const fixedAscii = (value, length) => {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) throw new RangeError(`ASCII field exceeds ${length} bytes`);
  const bytes = Buffer.alloc(length);
  encoded.copy(bytes);
  return bytes;
};

const fixedShiftJis = (value, length) => {
  const encoded = shiftJisNames.get(value);
  if (!encoded) throw new RangeError(`No fixture Shift-JIS mapping for ${JSON.stringify(value)}`);
  if (encoded.byteLength > length) throw new RangeError(`Shift-JIS field exceeds ${length} bytes`);
  const bytes = Buffer.alloc(length);
  Buffer.from(encoded).copy(bytes);
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
  fixedShiftJis(name, 15),
  uint32(frame),
  float32Tuple(translation),
  float32Tuple(normalizedQuaternion(rotation)),
  linearInterpolation(),
]);

const upperBodyAngle = 35 * Math.PI / 180;

const defaultFrames = Object.freeze([
  {
    name: "センター",
    frame: 0,
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
  },
  {
    name: "上半身",
    frame: 0,
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
  },
  {
    name: "センター",
    frame: 30,
    translation: [2, 0.75, 0],
    rotation: [0, 0, 0, 1],
  },
  {
    name: "上半身",
    frame: 30,
    translation: [0, 0, 0],
    rotation: [0, 0, Math.sin(upperBodyAngle / 2), Math.cos(upperBodyAngle / 2)],
  },
]);

const createMinimalVmd = (frames = defaultFrames) => {
  const records = frames.map((frame) => boneFrame(frame));
  return Uint8Array.from(Buffer.concat([
    fixedAscii(SIGNATURE, 30),
    fixedAscii(MODEL_NAME, 20),
    uint32(records.length),
    ...records,
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(0),
    uint32(0),
  ]));
};

const writeMinimalVmd = async (outputPath = DEFAULT_OUTPUT) => {
  const resolved = resolve(outputPath);
  await mkdir(dirname(resolved), { recursive: true });
  const bytes = createMinimalVmd();
  await writeFile(resolved, bytes);
  return { outputPath: resolved, byteLength: bytes.byteLength };
};

if (require.main === module) {
  writeMinimalVmd(process.argv[2]).then(({ outputPath, byteLength }) => {
    process.stdout.write(`${JSON.stringify({ outputPath, byteLength }, null, 2)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_OUTPUT,
  MODEL_NAME,
  SIGNATURE,
  createMinimalVmd,
  writeMinimalVmd,
};
