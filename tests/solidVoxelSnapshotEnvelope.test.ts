import assert from "node:assert/strict";
import test from "node:test";
import {
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
} from "three";
import {
  decodeSolidVoxelSnapshotEnvelope,
  encodeSolidVoxelSnapshotEnvelope,
  solidVoxelSnapshotCrc32,
  SolidVoxelSnapshotEnvelopeError,
  SOLID_VOXEL_SNAPSHOT_DESCRIPTOR_SIZE,
  SOLID_VOXEL_SNAPSHOT_HEADER_SIZE,
  SOLID_VOXEL_SNAPSHOT_MAGIC,
} from "../src/core/solidVoxelSnapshotEnvelope";
import type { MeshMaterialSnapshot, MmdMeshSnapshot } from "../src/types";

const fullMaterial = (): MeshMaterialSnapshot => ({
  name: "顔_材質",
  englishName: "Face material",
  baseColor: [0.2, 0.4, 0.6, 0.8],
  textureFactor: [0.9, 0.8, 0.7, 0.6],
  textureAdditiveFactor: [0.01, 0.02, 0.03, 0.04],
  hasTexture: true,
  textureIndex: 0,
  textureMatrix: [1, 0, 0, 0, -1, 0, 0.25, 0.75, 1],
  wrapS: MirroredRepeatWrapping,
  wrapT: ClampToEdgeWrapping,
  flipY: true,
  ambient: [0.1, 0.2, 0.3],
  emissive: true,
});

const fullSnapshot = (): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    -1.25, 0, 0.5,
    1.25, 0, 0.5,
    0, 2.5, -0.5,
  ]),
  indices: Uint32Array.of(0, 1, 2),
  triangleMaterials: Uint16Array.of(0),
  uvs: Float32Array.of(0, 0, 1, 0, 0.5, 1),
  faceFrame: {
    origin: [0, 1.5, 0],
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, 1],
    eyeDistance: 0.75,
    confidence: 0.9,
  },
  materials: [fullMaterial()],
  textures: [{
    width: 2,
    height: 1,
    pixels: Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 128),
  }],
});

const minimalSnapshot = (): MmdMeshSnapshot => ({
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
  indices: Uint32Array.of(0, 1, 2),
  triangleMaterials: new Uint16Array(0),
});

const expectCode = (code: string, operation: () => unknown) => assert.throws(
  operation,
  (error: unknown) => error instanceof SolidVoxelSnapshotEnvelopeError && error.code === code,
);

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const rewriteChecksum = (bytes: Uint8Array) => {
  const view = viewOf(bytes);
  view.setUint32(24, 0, true);
  view.setUint32(24, solidVoxelSnapshotCrc32(bytes, true), true);
  return bytes;
};

const descriptorOffset = (sectionIndex: number) =>
  SOLID_VOXEL_SNAPSHOT_HEADER_SIZE + sectionIndex * SOLID_VOXEL_SNAPSHOT_DESCRIPTOR_SIZE;

test("raw snapshot v1 round-trips every field without sharing source storage", () => {
  const source = fullSnapshot();
  const encoded = encodeSolidVoxelSnapshotEnvelope(0xfedc_ba98_7654_3210n, source);
  const decoded = decodeSolidVoxelSnapshotEnvelope(encoded);

  assert.ok(encoded instanceof Uint8Array);
  assert.equal(decoded.jobId, 0xfedc_ba98_7654_3210n);
  assert.equal(new TextDecoder().decode(encoded.subarray(0, 8)), SOLID_VOXEL_SNAPSHOT_MAGIC);
  assert.deepEqual([...decoded.snapshot.positions], [...source.positions]);
  assert.deepEqual([...decoded.snapshot.indices], [...source.indices]);
  assert.deepEqual([...decoded.snapshot.triangleMaterials], [...source.triangleMaterials]);
  assert.deepEqual([...decoded.snapshot.uvs ?? []], [...source.uvs ?? []]);
  assert.deepEqual(decoded.snapshot.faceFrame, source.faceFrame);
  assert.deepEqual(decoded.snapshot.materials, source.materials);
  assert.equal(decoded.snapshot.textures?.[0].width, 2);
  assert.deepEqual([...decoded.snapshot.textures?.[0].pixels ?? []], [...source.textures![0].pixels]);

  source.positions[0] = 99;
  source.textures![0].pixels[0] = 1;
  assert.equal(decoded.snapshot.positions[0], -1.25);
  assert.equal(decoded.snapshot.textures?.[0].pixels[0], 255);
});

test("material names preserve a leading Unicode BOM as ordinary data", () => {
  const source = fullSnapshot();
  source.materials![0].name = "\ufeff材质";
  const decoded = decodeSolidVoxelSnapshotEnvelope(
    encodeSolidVoxelSnapshotEnvelope(1n, source),
  );
  assert.equal(decoded.snapshot.materials?.[0].name, "\ufeff材质");
});

test("optional sections use canonical zero descriptors and decode as absent", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(0n, minimalSnapshot());
  const decoded = decodeSolidVoxelSnapshotEnvelope(encoded);
  const view = viewOf(encoded);

  for (const sectionIndex of [2, 3, 4, 5, 6, 7]) {
    const offset = descriptorOffset(sectionIndex);
    assert.equal(view.getUint32(offset + 4, true), 0);
    assert.equal(view.getUint32(offset + 8, true), 0);
    assert.equal(view.getUint32(offset + 12, true), 0);
  }
  assert.equal(decoded.snapshot.uvs, undefined);
  assert.equal(decoded.snapshot.faceFrame, undefined);
  assert.equal(decoded.snapshot.materials, undefined);
  assert.equal(decoded.snapshot.textures, undefined);
  assert.equal(decoded.snapshot.triangleMaterials.length, 0);
});

test("minimal envelope remains a stable Rust compatibility fixture", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(0x0102_0304_0506_0708n, minimalSnapshot());
  assert.equal(encoded.byteLength, 288);
  assert.equal(viewOf(encoded).getUint32(24, true), 0xba5e_3625);
  assert.equal(
    Buffer.from(encoded).toString("hex"),
    "4d4c5953564f58000100280018000800000000002001000025365eba00000000"
      + "08070605040302010100010009000000e8000000240000000000000000000000"
      + "0200020003000000100100000c00000000000000000000000300030000000000"
      + "0000000000000000000000000000000004000100000000000000000000000000"
      + "0000000000000000050008000000000000000000000000000000000000000000"
      + "0600060000000000000000000000000000000000000000000700070000000000"
      + "0000000000000000000000000000000008000400000000000000000000000000"
      + "00000000000000000000000000000000000000000000803f00000000"
      + "00000000000000000000803f0000000000000000000000000100000002000000"
      + "00000000",
  );
});

test("encoder validates job IDs and snapshot cross-section relationships", () => {
  expectCode("invalid-job-id", () => encodeSolidVoxelSnapshotEnvelope(-1n, minimalSnapshot()));
  expectCode("invalid-job-id", () => encodeSolidVoxelSnapshotEnvelope(1n << 64n, minimalSnapshot()));

  const badIndex = minimalSnapshot();
  badIndex.indices[2] = 3;
  expectCode("invalid-value", () => encodeSolidVoxelSnapshotEnvelope(1n, badIndex));

  const badMaterials = minimalSnapshot();
  badMaterials.triangleMaterials = Uint16Array.of(1);
  expectCode("invalid-value", () => encodeSolidVoxelSnapshotEnvelope(1n, badMaterials));

  const badTexture = fullSnapshot();
  badTexture.textures![0].pixels = Uint8ClampedArray.of(1, 2, 3, 4);
  expectCode("invalid-value", () => encodeSolidVoxelSnapshotEnvelope(1n, badTexture));
});

test("decoder rejects truncation, magic, version, total length, and checksum damage", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(7n, fullSnapshot());
  expectCode("truncated", () => decodeSolidVoxelSnapshotEnvelope(encoded.subarray(0, 39)));

  const badMagic = encoded.slice();
  badMagic[0] ^= 0xff;
  expectCode("invalid-magic", () => decodeSolidVoxelSnapshotEnvelope(badMagic));

  const badVersion = encoded.slice();
  viewOf(badVersion).setUint16(8, 2, true);
  expectCode("unsupported-version", () => decodeSolidVoxelSnapshotEnvelope(badVersion));

  const badLength = encoded.slice();
  viewOf(badLength).setUint32(20, badLength.length - 8, true);
  expectCode("truncated", () => decodeSolidVoxelSnapshotEnvelope(badLength));

  const badChecksum = encoded.slice();
  badChecksum[badChecksum.length - 8] ^= 1;
  expectCode("checksum-mismatch", () => decodeSolidVoxelSnapshotEnvelope(badChecksum));
});

test("decoder rejects descriptor overflow, misalignment, overlap, and extra zero holes", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(9n, fullSnapshot());
  const encodedView = viewOf(encoded);
  const firstOffset = encodedView.getUint32(descriptorOffset(0) + 8, true);
  const firstLength = encodedView.getUint32(descriptorOffset(0) + 12, true);

  const overflow = encoded.slice();
  viewOf(overflow).setUint32(descriptorOffset(0) + 12, 0xffff_ffff, true);
  expectCode("truncated", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(overflow)));

  const misaligned = encoded.slice();
  viewOf(misaligned).setUint32(descriptorOffset(0) + 8, firstOffset + 1, true);
  expectCode("misaligned", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(misaligned)));

  const overlap = encoded.slice();
  viewOf(overlap).setUint32(descriptorOffset(1) + 8, firstOffset, true);
  expectCode("overlap", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(overlap)));

  const hole = encoded.slice();
  const canonicalSecondOffset = (firstOffset + firstLength + 7) & ~7;
  viewOf(hole).setUint32(descriptorOffset(1) + 8, canonicalSecondOffset + 8, true);
  expectCode("invalid-descriptor", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(hole)));
});

test("decoder rejects non-zero alignment padding and non-canonical tail length", () => {
  const source = fullSnapshot();
  source.positions = Float32Array.of(
    -1.25, 0, 0.5,
    1.25, 0, 0.5,
    0, 2.5, -0.5,
    0, 1, 0,
    0, 1.5, 0,
  );
  source.indices = Uint32Array.of(0, 1, 2);
  source.uvs = Float32Array.of(0, 0, 1, 0, 0.5, 1, 0.5, 0.5, 0.5, 0.75);
  const encoded = encodeSolidVoxelSnapshotEnvelope(11n, source);
  const view = viewOf(encoded);
  const firstEnd = view.getUint32(descriptorOffset(0) + 8, true)
    + view.getUint32(descriptorOffset(0) + 12, true);
  const nextStart = view.getUint32(descriptorOffset(1) + 8, true);
  assert.ok(nextStart > firstEnd);

  const padding = encoded.slice();
  padding[firstEnd] = 1;
  expectCode("non-zero-padding", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(padding)));

  const extended = new Uint8Array(encoded.length + 8);
  extended.set(encoded);
  viewOf(extended).setUint32(20, extended.length, true);
  expectCode("invalid-header", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(extended)));
});

test("decoder validates UTF-8, material flags, and texture pixel ranges", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(13n, fullSnapshot());
  const baseView = viewOf(encoded);
  const materialOffset = baseView.getUint32(descriptorOffset(5) + 8, true);
  const textureMetadataOffset = baseView.getUint32(descriptorOffset(6) + 8, true);

  const flags = encoded.slice();
  viewOf(flags).setUint32(materialOffset + 12, 1 << 31, true);
  expectCode("invalid-descriptor", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(flags)));

  const utf8 = encoded.slice();
  utf8[materialOffset + 224] = 0xff;
  expectCode("invalid-utf8", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(utf8)));

  const pixelRange = encoded.slice();
  viewOf(pixelRange).setUint32(textureMetadataOffset + 8, 1, true);
  expectCode("overlap", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(pixelRange)));
});

test("decoder rejects non-finite geometry and malformed element counts after a valid CRC", () => {
  const encoded = encodeSolidVoxelSnapshotEnvelope(15n, fullSnapshot());
  const view = viewOf(encoded);
  const positionsOffset = view.getUint32(descriptorOffset(0) + 8, true);

  const nonFinite = encoded.slice();
  viewOf(nonFinite).setFloat32(positionsOffset, Number.NaN, true);
  expectCode("invalid-value", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(nonFinite)));

  const malformed = encoded.slice();
  viewOf(malformed).setUint32(descriptorOffset(3) + 4, 5, true);
  expectCode("invalid-section", () => decodeSolidVoxelSnapshotEnvelope(rewriteChecksum(malformed)));
});
