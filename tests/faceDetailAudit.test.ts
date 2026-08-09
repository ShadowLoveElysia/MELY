import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createLitematicFromDocument } from "../src/core/litematic";
import { createProjectionDocument } from "../src/core/projectionDocument";
import type { ProjectionBlockState } from "../src/types";

interface DecodedProjection {
  blocks: Map<string, { position: [number, number, number]; state: string }>;
}

interface FaceAuditResult {
  conclusive: boolean;
  passed: boolean;
  coordinates: {
    balanced: { equal: boolean };
    strong: { equal: boolean };
  };
  visibleFace?: {
    balanced: { changedVisibleFaceCells: number; zones: Record<string, number> };
    strong: {
      changedVisibleFaceCells: number;
      zones: Record<string, number>;
      candidateStatesByZone: Record<string, Array<{ value: string; count: number }>>;
    };
    midlineCrossings: { balanced: unknown[]; strong: unknown[] };
  };
  assertions: Record<string, boolean>;
}

const require = createRequire(import.meta.url);
const {
  auditFaceDetailVariants,
  decodeLitematicBytes,
  faceFrameFromSidecar,
} = require("../scripts/lib/face-detail-audit.cjs") as {
  auditFaceDetailVariants: (input: {
    off: DecodedProjection;
    balanced: DecodedProjection;
    strong: DecodedProjection;
    faceFrame: ReturnType<typeof faceFrameFromSidecar>;
  }) => FaceAuditResult;
  decodeLitematicBytes: (bytes: Uint8Array, path?: string) => Promise<DecodedProjection>;
  faceFrameFromSidecar: (value: unknown) => {
    origin: [number, number, number];
    right: [number, number, number];
    up: [number, number, number];
    forward: [number, number, number];
    eyeDistance: number;
    confidence?: number;
  };
};

const palette: ProjectionBlockState[] = [
  { blockId: "minecraft:white_terracotta" },
  { blockId: "minecraft:blue_concrete" },
  { blockId: "minecraft:red_concrete" },
  { blockId: "minecraft:black_concrete" },
];

const coordinateKey = (position: readonly number[]) => position.join(",");

const sourceCoordinates = Array.from({ length: 7 }, (_, y) =>
  Array.from({ length: 9 }, (_, x) => [10 + x, 20 + y, 30] as [number, number, number]))
  .flat();

const projection = async (
  states: ReadonlyMap<string, number>,
  extra: readonly [number, number, number][] = [],
) => {
  const coordinates = [...sourceCoordinates, ...extra];
  const document = createProjectionDocument(coordinates.map((position) => ({
    position,
    paletteIndex: states.get(coordinateKey(position)) ?? 0,
  })), palette);
  const exported = createLitematicFromDocument(document, {
    name: "Face Audit Fixture",
    timestamp: 1,
    regionMaxSize: 32,
  });
  return decodeLitematicBytes(exported.bytes, "fixture.litematic");
};

const sidecar = {
  format: "MELYFaceProjectionSidecar",
  version: 1,
  coordinateSpace: "projection-result",
  faceFrame: {
    origin: [14, 23, 30],
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, 1],
    eyeDistance: 4,
    confidence: 1,
  },
  bounds: {
    min: [10, 20, 30],
    max: [18, 26, 30],
  },
};

test("face-detail audit decodes Litematica coordinates and accepts a separated three-level feature set", async () => {
  const balancedStates = new Map<string, number>([
    ["12,23,30", 1],
    ["16,23,30", 2],
    ["12,25,30", 1],
    ["16,25,30", 2],
    ["14,20,30", 3],
  ]);
  const strongStates = new Map(balancedStates);
  ["11,23,30", "13,23,30", "11,25,30", "13,25,30"].forEach((key) => strongStates.set(key, 1));
  ["15,23,30", "17,23,30", "15,25,30", "17,25,30"].forEach((key) => strongStates.set(key, 2));

  const [off, balanced, strong] = await Promise.all([
    projection(new Map()),
    projection(balancedStates),
    projection(strongStates),
  ]);
  const faceFrame = faceFrameFromSidecar(sidecar);
  assert.deepEqual(faceFrame.origin, [4, 3, 0]);

  const audit = auditFaceDetailVariants({ off, balanced, strong, faceFrame });
  assert.equal(audit.conclusive, true);
  assert.equal(audit.passed, true);
  assert.equal(audit.coordinates.balanced.equal, true);
  assert.equal(audit.coordinates.strong.equal, true);
  assert.equal(audit.visibleFace?.balanced.zones.eye, 2);
  assert.equal(audit.visibleFace?.balanced.zones.brow, 2);
  assert.equal(audit.visibleFace?.balanced.zones.mouth, 1);
  assert.deepEqual(
    audit.visibleFace?.strong.candidateStatesByZone.mouth,
    [{ value: "minecraft:black_concrete", count: 1 }],
  );
  assert.ok(
    (audit.visibleFace?.strong.changedVisibleFaceCells ?? 0)
      >= (audit.visibleFace?.balanced.changedVisibleFaceCells ?? 0),
  );
  assert.deepEqual(audit.visibleFace?.midlineCrossings, { balanced: [], strong: [] });
});

test("face-detail audit rejects coordinate drift and an eye-color component spanning the midline", async () => {
  const balancedStates = new Map<string, number>([["12,23,30", 1]]);
  const strongStates = new Map<string, number>();
  for (let x = 12; x <= 16; x += 1) strongStates.set(`${x},23,30`, 1);
  const [off, balanced, strong] = await Promise.all([
    projection(new Map()),
    projection(balancedStates),
    projection(strongStates, [[19, 23, 30]]),
  ]);

  const audit = auditFaceDetailVariants({
    off,
    balanced,
    strong,
    faceFrame: faceFrameFromSidecar(sidecar),
  });
  assert.equal(audit.passed, false);
  assert.equal(audit.coordinates.strong.equal, false);
  assert.equal(audit.assertions.strongEyeBrowDoesNotCrossMidline, false);
  assert.ok((audit.visibleFace?.midlineCrossings.strong.length ?? 0) > 0);
});

test("face-detail audit accepts same-color eyes when the center column remains clear", async () => {
  const balancedStates = new Map<string, number>([
    ["12,23,30", 1],
    ["16,23,30", 1],
  ]);
  const strongStates = new Map(balancedStates);
  ["11,23,30", "13,23,30", "15,23,30", "17,23,30"].forEach((key) => {
    strongStates.set(key, 1);
  });
  const [off, balanced, strong] = await Promise.all([
    projection(new Map()),
    projection(balancedStates),
    projection(strongStates),
  ]);

  const audit = auditFaceDetailVariants({
    off,
    balanced,
    strong,
    faceFrame: faceFrameFromSidecar(sidecar),
  });
  assert.equal(audit.passed, true);
  assert.deepEqual(audit.visibleFace?.midlineCrossings, { balanced: [], strong: [] });
});

test("face-detail audit refuses facial conclusions without a sidecar frame", async () => {
  const off = await projection(new Map());
  const audit = auditFaceDetailVariants({
    off,
    balanced: off,
    strong: off,
    faceFrame: undefined as never,
  });
  assert.equal(audit.conclusive, false);
  assert.equal(audit.passed, false);
});
