import type {
  FaceFrameSnapshot,
  MeshMaterialSnapshot,
  MeshTextureSnapshot,
  MmdMeshSnapshot,
} from "../types";

/** 桌面 Raw IPC 快照协议；所有多字节字段均为 little-endian。 */
export const SOLID_VOXEL_SNAPSHOT_MAGIC = "MLYSVOX\0";
export const SOLID_VOXEL_SNAPSHOT_VERSION = 1;
export const SOLID_VOXEL_SNAPSHOT_HEADER_SIZE = 40;
export const SOLID_VOXEL_SNAPSHOT_DESCRIPTOR_SIZE = 24;
export const SOLID_VOXEL_SNAPSHOT_SECTION_COUNT = 8;
export const SOLID_VOXEL_SNAPSHOT_ALIGNMENT = 8;

export const SOLID_VOXEL_SNAPSHOT_SECTION = {
  positions: 1,
  indices: 2,
  triangleMaterials: 3,
  uvs: 4,
  faceFrame: 5,
  materials: 6,
  textureMetadata: 7,
  texturePixels: 8,
} as const;

export const SOLID_VOXEL_SNAPSHOT_ELEMENT_TYPE = {
  f32: 1,
  u32: 2,
  u16: 3,
  u8: 4,
  f64: 5,
  material: 6,
  textureMetadata: 7,
  faceFrame: 8,
} as const;

const MAGIC = new TextEncoder().encode(SOLID_VOXEL_SNAPSHOT_MAGIC);
const CHECKSUM_OFFSET = 24;
const TABLE_OFFSET = SOLID_VOXEL_SNAPSHOT_HEADER_SIZE;
const DATA_OFFSET = 232;
const U32_MAX = 0xffff_ffff;
const MAX_RECORDS = 1 << 24;
const MAX_STRING_BYTES = 1 << 20;
const MATERIAL_FIXED_SIZE = 224;
const MATERIAL_NUMERIC_VALUES = 24;
const TEXTURE_RECORD_SIZE = 24;
const FACE_FRAME_VALUES = 14;

const MATERIAL_HAS_TEXTURE = 1 << 0;
const MATERIAL_FLIP_Y = 1 << 1;
const MATERIAL_EMISSIVE = 1 << 2;
const MATERIAL_FLAGS = MATERIAL_HAS_TEXTURE | MATERIAL_FLIP_Y | MATERIAL_EMISSIVE;

interface Section {
  kind: number;
  elementType: number;
  elementCount: number;
  payload: Uint8Array;
}

interface Descriptor {
  kind: number;
  elementType: number;
  elementCount: number;
  offset: number;
  byteLength: number;
  flags: number;
  reserved: number;
}

export type SolidVoxelSnapshotEnvelopeErrorCode =
  | "invalid-input"
  | "invalid-job-id"
  | "invalid-magic"
  | "unsupported-version"
  | "invalid-header"
  | "invalid-descriptor"
  | "truncated"
  | "overflow"
  | "misaligned"
  | "overlap"
  | "non-zero-padding"
  | "checksum-mismatch"
  | "invalid-section"
  | "invalid-utf8"
  | "invalid-value";

export class SolidVoxelSnapshotEnvelopeError extends Error {
  constructor(
    readonly code: SolidVoxelSnapshotEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolidVoxelSnapshotEnvelopeError";
  }
}

const fail = (code: SolidVoxelSnapshotEnvelopeErrorCode, message: string): never => {
  throw new SolidVoxelSnapshotEnvelopeError(code, message);
};

const align8 = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) return fail("overflow", "alignment input is out of range");
  const aligned = value + (8 - value % 8) % 8;
  if (aligned > U32_MAX) return fail("overflow", "aligned offset exceeds u32");
  return aligned;
};

const u32 = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) return fail("overflow", `${label} does not fit u32`);
  return value;
};

const i32 = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    return fail("invalid-value", `${label} does not fit i32`);
  }
  return value;
};

const finite = (value: number, label: string) => {
  if (!Number.isFinite(value)) return fail("invalid-value", `${label} must be finite`);
  return value;
};

const expectJobId = (jobId: bigint) => {
  if (typeof jobId !== "bigint" || jobId < 0n || jobId > 0xffff_ffff_ffff_ffffn) {
    return fail("invalid-job-id", "jobId must be an unsigned 64-bit bigint");
  }
  return jobId;
};

const rawBytes = (value: ArrayBufferView, label: string) => {
  if (!value || !Number.isInteger(value.byteLength)) return fail("invalid-input", `${label} must be a typed array`);
  if (value.byteLength > U32_MAX) return fail("overflow", `${label} exceeds u32`);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};

const encodeUtf8 = (value: unknown, label: string) => {
  if (typeof value !== "string") return fail("invalid-input", `${label} must be a string`);
  // TextEncoder would silently replace lone UTF-16 surrogates, which is not canonical.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return fail("invalid-utf8", `${label} contains an unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail("invalid-utf8", `${label} contains an unpaired surrogate`);
    }
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_STRING_BYTES) return fail("overflow", `${label} exceeds the string limit`);
  return bytes;
};

const decodeUtf8 = (bytes: Uint8Array, label: string) => {
  if (bytes.byteLength > MAX_STRING_BYTES) return fail("overflow", `${label} exceeds the string limit`);
  try {
    // `ignoreBOM` keeps a leading U+FEFF as data, matching Rust `from_utf8` exactly.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid-utf8", `${label} is not valid UTF-8`);
  }
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC，校验时 24..27 字节视为零。 */
export const solidVoxelSnapshotCrc32 = (bytes: Uint8Array, zeroChecksumField = false) => {
  let crc = 0xffff_ffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = zeroChecksumField && index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + 4 ? 0 : bytes[index];
    crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};

class Writer {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > U32_MAX) fail("overflow", "writer length exceeds u32");
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  writeU32(value: number) {
    if (this.offset + 4 > this.bytes.length) return fail("overflow", "writer overflow");
    this.view.setUint32(this.offset, u32(value, "u32"), true);
    this.offset += 4;
  }

  writeI32(value: number, label: string) {
    if (this.offset + 4 > this.bytes.length) return fail("overflow", "writer overflow");
    this.view.setInt32(this.offset, i32(value, label), true);
    this.offset += 4;
  }

  writeF64(value: number, label: string) {
    if (this.offset + 8 > this.bytes.length) return fail("overflow", "writer overflow");
    this.view.setFloat64(this.offset, finite(value, label), true);
    this.offset += 8;
  }

  writeBytes(value: Uint8Array) {
    if (this.offset + value.byteLength > this.bytes.length) return fail("overflow", "writer overflow");
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }
}

const faceFramePayload = (frame: FaceFrameSnapshot | undefined) => {
  if (!frame) return new Uint8Array(0);
  const values = [
    ...frame.origin,
    ...frame.right,
    ...frame.up,
    ...frame.forward,
    frame.eyeDistance,
    frame.confidence,
  ];
  if (values.length !== FACE_FRAME_VALUES || frame.eyeDistance <= 0) return fail("invalid-value", "faceFrame is invalid");
  const writer = new Writer(FACE_FRAME_VALUES * 8);
  values.forEach((value, index) => writer.writeF64(value, `faceFrame[${index}]`));
  return writer.bytes;
};

const checkFixedNumbers = (value: unknown, length: number, label: string) => {
  if (!Array.isArray(value) || value.length !== length) return fail("invalid-input", `${label} has an invalid shape`);
  value.forEach((entry, index) => finite(entry, `${label}[${index}]`));
  return value as number[];
};

const materialPayload = (materials: readonly MeshMaterialSnapshot[] | undefined) => {
  if (!materials?.length) return new Uint8Array(0);
  if (materials.length > MAX_RECORDS) return fail("overflow", "material count exceeds the protocol limit");
  const records = materials.map((material, index) => {
    const name = encodeUtf8(material.name, `material ${index} name`);
    const englishName = encodeUtf8(material.englishName, `material ${index} englishName`);
    const base = checkFixedNumbers(material.baseColor, 4, `material ${index} baseColor`);
    const factor = checkFixedNumbers(material.textureFactor, 4, `material ${index} textureFactor`);
    const additive = checkFixedNumbers(material.textureAdditiveFactor ?? [0, 0, 0, 0], 4, `material ${index} textureAdditiveFactor`);
    const matrix = checkFixedNumbers(material.textureMatrix, 9, `material ${index} textureMatrix`);
    const ambient = checkFixedNumbers(material.ambient, 3, `material ${index} ambient`);
    if (!Number.isInteger(material.textureIndex) || material.textureIndex < -1) return fail("invalid-value", `material ${index} textureIndex is invalid`);
    const flags = (material.hasTexture ? MATERIAL_HAS_TEXTURE : 0)
      | (material.flipY ? MATERIAL_FLIP_Y : 0)
      | (material.emissive ? MATERIAL_EMISSIVE : 0);
    const length = MATERIAL_FIXED_SIZE + name.length + englishName.length;
    u32(length, `material ${index} length`);
    const writer = new Writer(length);
    writer.writeU32(length);
    writer.writeU32(name.length);
    writer.writeU32(englishName.length);
    writer.writeU32(flags);
    writer.writeI32(material.textureIndex, `material ${index} textureIndex`);
    writer.writeI32(material.wrapS, `material ${index} wrapS`);
    writer.writeI32(material.wrapT, `material ${index} wrapT`);
    writer.writeU32(0);
    [...base, ...factor, ...additive, ...matrix, ...ambient]
      .forEach((value, valueIndex) => writer.writeF64(value, `material ${index} numeric[${valueIndex}]`));
    writer.writeBytes(name);
    writer.writeBytes(englishName);
    return writer.bytes;
  });
  const total = records.reduce((sum, record) => u32(sum + record.length, "material payload length"), 0);
  const writer = new Writer(total);
  records.forEach(record => writer.writeBytes(record));
  return writer.bytes;
};

const texturePayloads = (textures: readonly MeshTextureSnapshot[] | undefined) => {
  if (!textures?.length) return { metadata: new Uint8Array(0), pixels: new Uint8Array(0) };
  if (textures.length > MAX_RECORDS) return fail("overflow", "texture count exceeds the protocol limit");
  const metadata = new Writer(textures.length * TEXTURE_RECORD_SIZE);
  const parts: Uint8Array[] = [];
  let pixelOffset = 0;
  textures.forEach((texture, index) => {
    if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width <= 0 || texture.height <= 0) {
      return fail("invalid-value", `texture ${index} dimensions are invalid`);
    }
    const area = texture.width * texture.height;
    if (!Number.isSafeInteger(area) || area > U32_MAX / 4) return fail("overflow", `texture ${index} dimensions overflow`);
    const pixels = rawBytes(texture.pixels, `texture ${index} pixels`);
    const expected = area * 4;
    if (pixels.byteLength !== expected) return fail("invalid-value", `texture ${index} pixel length must be ${expected}`);
    metadata.writeU32(texture.width);
    metadata.writeU32(texture.height);
    metadata.writeU32(pixelOffset);
    metadata.writeU32(expected);
    metadata.writeU32(0);
    metadata.writeU32(0);
    parts.push(pixels.slice());
    pixelOffset = u32(pixelOffset + expected, "texture pixel length");
  });
  const pixels = new Uint8Array(pixelOffset);
  let offset = 0;
  parts.forEach((part) => {
    pixels.set(part, offset);
    offset += part.length;
  });
  return { metadata: metadata.bytes, pixels };
};

const hostIsLittleEndian = (() => {
  const probe = new Uint16Array([0x0102]);
  return new Uint8Array(probe.buffer)[0] === 0x02;
})();

const littleEndianTypedPayload = (
  value: Float32Array | Uint32Array | Uint16Array,
  label: string,
) => {
  if (hostIsLittleEndian) return rawBytes(value, label).slice();
  const writer = new Writer(value.byteLength);
  value.forEach((entry) => {
    if (value instanceof Float32Array) {
      writer.view.setFloat32(writer.offset, entry, true);
      writer.offset += 4;
    } else if (value instanceof Uint32Array) {
      writer.view.setUint32(writer.offset, entry, true);
      writer.offset += 4;
    } else {
      writer.view.setUint16(writer.offset, entry, true);
      writer.offset += 2;
    }
  });
  return writer.bytes;
};

const validateSnapshot = (snapshot: MmdMeshSnapshot) => {
  if (!snapshot || !(snapshot.positions instanceof Float32Array) || !snapshot.positions.length || snapshot.positions.length % 3) {
    return fail("invalid-input", "positions must be a non-empty Float32Array divisible by three");
  }
  if (!(snapshot.indices instanceof Uint32Array) || !snapshot.indices.length || snapshot.indices.length % 3) {
    return fail("invalid-input", "indices must be a non-empty Uint32Array divisible by three");
  }
  if (!(snapshot.triangleMaterials instanceof Uint16Array)) return fail("invalid-input", "triangleMaterials must be a Uint16Array");
  const vertexCount = snapshot.positions.length / 3;
  const triangleCount = snapshot.indices.length / 3;
  snapshot.positions.forEach((value, index) => finite(value, `positions[${index}]`));
  snapshot.indices.forEach((value, index) => {
    if (value >= vertexCount) return fail("invalid-value", `indices[${index}] is out of bounds`);
  });
  if (snapshot.triangleMaterials.length !== 0 && snapshot.triangleMaterials.length !== triangleCount) {
    return fail("invalid-value", "triangleMaterials length must be zero or triangle count");
  }
  if (snapshot.uvs) {
    if (!(snapshot.uvs instanceof Float32Array) || snapshot.uvs.length !== vertexCount * 2) return fail("invalid-value", "UV count is invalid");
    snapshot.uvs.forEach((value, index) => finite(value, `uvs[${index}]`));
  }
  const materialCount = snapshot.materials?.length ?? 0;
  snapshot.triangleMaterials.forEach((value) => {
    if (materialCount ? value >= materialCount : value !== 0) return fail("invalid-value", "triangle material index is out of bounds");
  });
  const textureCount = snapshot.textures?.length ?? 0;
  snapshot.materials?.forEach((material, index) => {
    if (material.textureIndex >= textureCount) return fail("invalid-value", `material ${index} textureIndex is out of bounds`);
  });
};

const sectionsFor = (snapshot: MmdMeshSnapshot): Section[] => {
  validateSnapshot(snapshot);
  const textures = texturePayloads(snapshot.textures);
  return [
    { kind: 1, elementType: 1, elementCount: snapshot.positions.length, payload: littleEndianTypedPayload(snapshot.positions, "positions") },
    { kind: 2, elementType: 2, elementCount: snapshot.indices.length, payload: littleEndianTypedPayload(snapshot.indices, "indices") },
    { kind: 3, elementType: 3, elementCount: snapshot.triangleMaterials.length, payload: littleEndianTypedPayload(snapshot.triangleMaterials, "triangleMaterials") },
    { kind: 4, elementType: 1, elementCount: snapshot.uvs?.length ?? 0, payload: snapshot.uvs ? littleEndianTypedPayload(snapshot.uvs, "uvs") : new Uint8Array(0) },
    { kind: 5, elementType: 8, elementCount: snapshot.faceFrame ? 1 : 0, payload: faceFramePayload(snapshot.faceFrame) },
    { kind: 6, elementType: 6, elementCount: snapshot.materials?.length ?? 0, payload: materialPayload(snapshot.materials) },
    { kind: 7, elementType: 7, elementCount: snapshot.textures?.length ?? 0, payload: textures.metadata },
    { kind: 8, elementType: 4, elementCount: textures.pixels.length, payload: textures.pixels },
  ];
};

/** 将完整实体快照编码为 Tauri 顶层 Raw body。 */
export const encodeSolidVoxelSnapshotEnvelope = (jobId: bigint, snapshot: MmdMeshSnapshot): Uint8Array => {
  expectJobId(jobId);
  const sections = sectionsFor(snapshot);
  const descriptors: Descriptor[] = [];
  let cursor = DATA_OFFSET;
  sections.forEach((section) => {
    if (!section.payload.length) {
      if (section.elementCount) return fail("invalid-section", `section ${section.kind} has a count but no payload`);
      descriptors.push({ kind: section.kind, elementType: section.elementType, elementCount: 0, offset: 0, byteLength: 0, flags: 0, reserved: 0 });
      return;
    }
    cursor = align8(cursor);
    descriptors.push({
      kind: section.kind,
      elementType: section.elementType,
      elementCount: u32(section.elementCount, "element count"),
      offset: cursor,
      byteLength: u32(section.payload.length, "section length"),
      flags: 0,
      reserved: 0,
    });
    cursor = u32(cursor + section.payload.length, "envelope length");
  });
  const totalLength = align8(cursor);
  if (totalLength > 0x7fff_ffff) return fail("overflow", "envelope exceeds the typed-array limit");
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(8, SOLID_VOXEL_SNAPSHOT_VERSION, true);
  view.setUint16(10, SOLID_VOXEL_SNAPSHOT_HEADER_SIZE, true);
  view.setUint16(12, SOLID_VOXEL_SNAPSHOT_DESCRIPTOR_SIZE, true);
  view.setUint16(14, SOLID_VOXEL_SNAPSHOT_SECTION_COUNT, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, totalLength, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  view.setBigUint64(32, jobId, true);
  descriptors.forEach((descriptor, index) => {
    const offset = TABLE_OFFSET + index * SOLID_VOXEL_SNAPSHOT_DESCRIPTOR_SIZE;
    view.setUint16(offset, descriptor.kind, true);
    view.setUint16(offset + 2, descriptor.elementType, true);
    view.setUint32(offset + 4, descriptor.elementCount, true);
    view.setUint32(offset + 8, descriptor.offset, true);
    view.setUint32(offset + 12, descriptor.byteLength, true);
    view.setUint32(offset + 16, 0, true);
    view.setUint32(offset + 20, 0, true);
  });
  sections.forEach((section, index) => {
    const offset = descriptors[index].offset;
    if (offset) bytes.set(section.payload, offset);
  });
  view.setUint32(CHECKSUM_OFFSET, solidVoxelSnapshotCrc32(bytes, true), true);
  return bytes;
};

const ensureRange = (bytes: Uint8Array, offset: number, length: number, label: string) => {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || offset < 0 || length < 0 || end > bytes.length) return fail("truncated", `${label} exceeds envelope bounds`);
};

const paddingIsZero = (bytes: Uint8Array, start: number, end: number) => {
  for (let index = start; index < end; index += 1) if (bytes[index]) return false;
  return true;
};

const decodeTyped = <T extends Float32Array | Uint32Array | Uint16Array>(
  bytes: Uint8Array,
  descriptor: Descriptor,
  bytesPerElement: number,
  Type: { new(buffer: ArrayBuffer): T },
  kind: "f32" | "u32" | "u16",
  label: string,
) => {
  const expected = descriptor.elementCount * bytesPerElement;
  if (!Number.isSafeInteger(expected) || expected !== descriptor.byteLength) return fail("invalid-section", `${label} byte length is invalid`);
  const copy = bytes.slice(descriptor.offset, descriptor.offset + descriptor.byteLength);
  if (hostIsLittleEndian) return new Type(copy.buffer);
  const result = new Type(new ArrayBuffer(copy.byteLength));
  const view = new DataView(copy.buffer);
  for (let index = 0; index < descriptor.elementCount; index += 1) {
    result[index] = (kind === "f32"
      ? view.getFloat32(index * bytesPerElement, true)
      : kind === "u32"
        ? view.getUint32(index * bytesPerElement, true)
        : view.getUint16(index * bytesPerElement, true)) as T[number];
  }
  return result;
};

const decodeFaceFrame = (bytes: Uint8Array, descriptor: Descriptor): FaceFrameSnapshot | undefined => {
  if (!descriptor.byteLength) return undefined;
  if (descriptor.elementCount !== 1 || descriptor.byteLength !== FACE_FRAME_VALUES * 8) return fail("invalid-section", "faceFrame size is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset + descriptor.offset, descriptor.byteLength);
  const values = Array.from({ length: FACE_FRAME_VALUES }, (_, index) => view.getFloat64(index * 8, true));
  values.forEach((value, index) => finite(value, `faceFrame[${index}]`));
  if (values[12] <= 0) return fail("invalid-value", "faceFrame eyeDistance must be positive");
  return {
    origin: values.slice(0, 3) as [number, number, number],
    right: values.slice(3, 6) as [number, number, number],
    up: values.slice(6, 9) as [number, number, number],
    forward: values.slice(9, 12) as [number, number, number],
    eyeDistance: values[12],
    confidence: values[13],
  };
};

const decodeTextures = (bytes: Uint8Array, metadata: Descriptor, pixels: Descriptor): MeshTextureSnapshot[] | undefined => {
  if (!metadata.byteLength) {
    if (pixels.byteLength) return fail("invalid-section", "texture pixels exist without metadata");
    return undefined;
  }
  if (metadata.byteLength !== metadata.elementCount * TEXTURE_RECORD_SIZE || pixels.elementCount !== pixels.byteLength) {
    return fail("invalid-section", "texture section length is invalid");
  }
  const meta = new DataView(bytes.buffer, bytes.byteOffset + metadata.offset, metadata.byteLength);
  const pixelBytes = bytes.slice(pixels.offset, pixels.offset + pixels.byteLength);
  const textures: MeshTextureSnapshot[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < metadata.elementCount; index += 1) {
    const offset = index * TEXTURE_RECORD_SIZE;
    const width = meta.getUint32(offset, true);
    const height = meta.getUint32(offset + 4, true);
    const pixelOffset = meta.getUint32(offset + 8, true);
    const pixelLength = meta.getUint32(offset + 12, true);
    if (meta.getUint32(offset + 16, true) || meta.getUint32(offset + 20, true)) return fail("invalid-descriptor", `texture ${index} reserved fields are non-zero`);
    const area = width * height;
    if (!width || !height || !Number.isSafeInteger(area) || area > U32_MAX / 4 || pixelLength !== area * 4) return fail("invalid-value", `texture ${index} dimensions are invalid`);
    if (pixelOffset !== expectedOffset || pixelOffset + pixelLength > pixelBytes.length) return fail("overlap", `texture ${index} pixel range is not canonical`);
    textures.push({ width, height, pixels: new Uint8ClampedArray(pixelBytes.slice(pixelOffset, pixelOffset + pixelLength)) });
    expectedOffset += pixelLength;
  }
  if (expectedOffset !== pixelBytes.length) return fail("invalid-section", "texture pixel section has trailing bytes");
  return textures;
};

const decodeMaterials = (bytes: Uint8Array, descriptor: Descriptor, textureCount: number): MeshMaterialSnapshot[] | undefined => {
  if (!descriptor.byteLength) return undefined;
  if (!descriptor.elementCount || descriptor.elementCount > MAX_RECORDS) return fail("invalid-section", "material count is invalid");
  const section = bytes.slice(descriptor.offset, descriptor.offset + descriptor.byteLength);
  const view = new DataView(section.buffer);
  const result: MeshMaterialSnapshot[] = [];
  let offset = 0;
  for (let index = 0; index < descriptor.elementCount; index += 1) {
    ensureRange(section, offset, MATERIAL_FIXED_SIZE, `material ${index}`);
    const length = view.getUint32(offset, true);
    const nameLength = view.getUint32(offset + 4, true);
    const englishLength = view.getUint32(offset + 8, true);
    const flags = view.getUint32(offset + 12, true);
    if (flags & ~MATERIAL_FLAGS) return fail("invalid-descriptor", `material ${index} flags are invalid`);
    if (length !== MATERIAL_FIXED_SIZE + nameLength + englishLength || offset + length > section.length) return fail("truncated", `material ${index} record is invalid`);
    const textureIndex = view.getInt32(offset + 16, true);
    const wrapS = view.getInt32(offset + 20, true);
    const wrapT = view.getInt32(offset + 24, true);
    if (view.getUint32(offset + 28, true)) return fail("invalid-descriptor", `material ${index} reserved field is non-zero`);
    const values = Array.from(
      { length: MATERIAL_NUMERIC_VALUES },
      (_, valueIndex) => view.getFloat64(offset + 32 + valueIndex * 8, true),
    );
    values.forEach((value, valueIndex) => finite(value, `material ${index} numeric[${valueIndex}]`));
    if (textureIndex < -1 || textureIndex >= textureCount && textureIndex >= 0) return fail("invalid-value", `material ${index} textureIndex is invalid`);
    const nameStart = offset + MATERIAL_FIXED_SIZE;
    const englishStart = nameStart + nameLength;
    result.push({
      name: decodeUtf8(section.slice(nameStart, englishStart), `material ${index} name`),
      englishName: decodeUtf8(section.slice(englishStart, offset + length), `material ${index} englishName`),
      baseColor: values.slice(0, 4) as [number, number, number, number],
      textureFactor: values.slice(4, 8) as [number, number, number, number],
      textureAdditiveFactor: values.slice(8, 12) as [number, number, number, number],
      hasTexture: Boolean(flags & MATERIAL_HAS_TEXTURE),
      textureIndex,
      textureMatrix: values.slice(12, 21) as [number, number, number, number, number, number, number, number, number],
      wrapS,
      wrapT,
      flipY: Boolean(flags & MATERIAL_FLIP_Y),
      ambient: values.slice(21, 24) as [number, number, number],
      emissive: Boolean(flags & MATERIAL_EMISSIVE),
    });
    offset += length;
  }
  if (offset !== section.length) return fail("invalid-section", "material section has trailing bytes");
  return result;
};

const expectedTypes = [1, 2, 3, 1, 8, 6, 7, 4];

/** 完整校验后解码；任何未知保留位、非规范 padding 或重叠都会失败。 */
export const decodeSolidVoxelSnapshotEnvelope = (input: Uint8Array): { jobId: bigint; snapshot: MmdMeshSnapshot } => {
  if (!(input instanceof Uint8Array)) return fail("invalid-input", "envelope must be a Uint8Array");
  const bytes = input.slice();
  if (bytes.length < SOLID_VOXEL_SNAPSHOT_HEADER_SIZE) return fail("truncated", "header is truncated");
  for (let index = 0; index < MAGIC.length; index += 1) if (bytes[index] !== MAGIC[index]) return fail("invalid-magic", "magic is invalid");
  const view = new DataView(bytes.buffer);
  if (view.getUint16(8, true) !== 1) return fail("unsupported-version", "version is unsupported");
  if (view.getUint16(10, true) !== 40 || view.getUint16(12, true) !== 24 || view.getUint16(14, true) !== 8) return fail("invalid-header", "header dimensions are invalid");
  if (view.getUint32(16, true) || view.getUint32(28, true)) return fail("invalid-header", "reserved header fields are non-zero");
  const totalLength = view.getUint32(20, true);
  if (totalLength !== bytes.length || totalLength < DATA_OFFSET || totalLength % 8) return fail("truncated", "total length is invalid");
  if (view.getUint32(24, true) !== solidVoxelSnapshotCrc32(bytes, true)) return fail("checksum-mismatch", "checksum mismatch");
  const descriptors: Descriptor[] = [];
  let previousEnd = DATA_OFFSET;
  let sawData = false;
  for (let index = 0; index < 8; index += 1) {
    const offset = TABLE_OFFSET + index * 24;
    const descriptor = {
      kind: view.getUint16(offset, true),
      elementType: view.getUint16(offset + 2, true),
      elementCount: view.getUint32(offset + 4, true),
      offset: view.getUint32(offset + 8, true),
      byteLength: view.getUint32(offset + 12, true),
      flags: view.getUint32(offset + 16, true),
      reserved: view.getUint32(offset + 20, true),
    };
    if (descriptor.kind !== index + 1 || descriptor.elementType !== expectedTypes[index] || descriptor.flags || descriptor.reserved) {
      return fail("invalid-descriptor", `descriptor ${index + 1} is invalid`);
    }
    if (!descriptor.byteLength || !descriptor.elementCount) {
      if (descriptor.byteLength || descriptor.elementCount || descriptor.offset) return fail("invalid-descriptor", `empty descriptor ${index + 1} is not canonical`);
      descriptors.push(descriptor);
      continue;
    }
    if (descriptor.offset % 8) return fail("misaligned", `section ${index + 1} offset is misaligned`);
    ensureRange(bytes, descriptor.offset, descriptor.byteLength, `section ${index + 1}`);
    if (descriptor.offset < DATA_OFFSET || sawData && descriptor.offset < previousEnd) return fail("overlap", `section ${index + 1} overlaps another section`);
    const expectedOffset = align8(sawData ? previousEnd : DATA_OFFSET);
    if (descriptor.offset !== expectedOffset) return fail("invalid-descriptor", `section ${index + 1} offset is not canonical`);
    if (!paddingIsZero(bytes, sawData ? previousEnd : DATA_OFFSET, descriptor.offset)) return fail("non-zero-padding", `padding before section ${index + 1} is non-zero`);
    sawData = true;
    previousEnd = descriptor.offset + descriptor.byteLength;
    descriptors.push(descriptor);
  }
  if (bytes.length !== align8(previousEnd)) return fail("invalid-header", "envelope tail length is not canonical");
  if (!paddingIsZero(bytes, previousEnd, bytes.length)) return fail("non-zero-padding", "trailing padding is non-zero");
  const positions = decodeTyped(bytes, descriptors[0], 4, Float32Array, "f32", "positions");
  const indices = decodeTyped(bytes, descriptors[1], 4, Uint32Array, "u32", "indices");
  if (!positions.length || positions.length % 3 || !indices.length || indices.length % 3) return fail("invalid-section", "positions or indices count is invalid");
  positions.forEach((value, index) => finite(value, `positions[${index}]`));
  const vertexCount = positions.length / 3;
  indices.forEach((value, index) => { if (value >= vertexCount) return fail("invalid-value", `indices[${index}] is out of bounds`); });
  const triangleCount = indices.length / 3;
  if (descriptors[2].elementCount && descriptors[2].elementCount !== triangleCount) return fail("invalid-section", "triangle material count is invalid");
  const triangleMaterials = descriptors[2].byteLength
    ? decodeTyped(bytes, descriptors[2], 2, Uint16Array, "u16", "triangleMaterials")
    : new Uint16Array(0);
  if (descriptors[3].elementCount && descriptors[3].elementCount !== vertexCount * 2) return fail("invalid-section", "UV count is invalid");
  const uvs = descriptors[3].byteLength ? decodeTyped(bytes, descriptors[3], 4, Float32Array, "f32", "uvs") : undefined;
  uvs?.forEach((value, index) => finite(value, `uvs[${index}]`));
  const textures = decodeTextures(bytes, descriptors[6], descriptors[7]);
  const materials = decodeMaterials(bytes, descriptors[5], textures?.length ?? 0);
  triangleMaterials.forEach((value) => {
    if (materials?.length ? value >= materials.length : value !== 0) return fail("invalid-value", "triangle material index is out of bounds");
  });
  const faceFrame = decodeFaceFrame(bytes, descriptors[4]);
  return {
    jobId: view.getBigUint64(32, true),
    snapshot: {
      positions,
      indices,
      triangleMaterials,
      ...(uvs ? { uvs } : {}),
      ...(faceFrame ? { faceFrame } : {}),
      ...(materials ? { materials } : {}),
      ...(textures ? { textures } : {}),
    },
  };
};
