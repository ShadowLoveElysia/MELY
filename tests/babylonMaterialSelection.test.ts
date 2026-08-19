import assert from "node:assert/strict";
import test from "node:test";
import {
  babylonMaterialPointerMovedPastThreshold,
  createBabylonVisibleMaterialTrianglePredicate,
  findBabylonSubMeshById,
  resolveBabylonMaterialPick,
} from "../src/core/babylonMaterialSelection.ts";

const selectionFixture = () => {
  const visibleMaterial = { alpha: 1 };
  const transparentMaterial = { alpha: 0 };
  const sourceMesh = {
    getIndices: () => [0, 1, 2, 3, 4, 5],
    subMeshes: [
      {
        _id: 17,
        materialIndex: 0,
        indexStart: 0,
        indexCount: 3,
        getMaterial: () => visibleMaterial,
      },
      {
        _id: 4,
        materialIndex: 1,
        indexStart: 3,
        indexCount: 3,
        getMaterial: () => transparentMaterial,
      },
    ],
  };
  const viewport = {
    sourceMeshes: [sourceMesh],
    resolveMaterialIndex: (mesh: unknown, subMeshId: number) => {
      if (mesh !== sourceMesh) return null;
      if (subMeshId === 17) return 1;
      if (subMeshId === 4) return 0;
      return null;
    },
  };
  return { sourceMesh, viewport };
};

test("Babylon submesh resolution uses the internal id rather than the array index", () => {
  const { sourceMesh } = selectionFixture();
  assert.equal(findBabylonSubMeshById(sourceMesh as never, 4)?.materialIndex, 1);
  assert.equal(findBabylonSubMeshById(sourceMesh as never, 1), null);
});

test("Babylon picks are distance ordered and skip hidden or runtime-transparent materials", () => {
  const { sourceMesh, viewport } = selectionFixture();
  const picks = [
    { hit: true, distance: 8, pickedMesh: sourceMesh, subMeshId: 17 },
    { hit: true, distance: 2, pickedMesh: sourceMesh, subMeshId: 4 },
  ];

  assert.equal(resolveBabylonMaterialPick(
    picks as never,
    viewport,
    2,
    new Set(),
  ), 1);
  assert.equal(resolveBabylonMaterialPick(
    picks as never,
    viewport,
    2,
    new Set([1]),
  ), null);
});

test("Babylon material picks reject foreign meshes and out-of-range resolver results", () => {
  const { sourceMesh, viewport } = selectionFixture();
  const foreignMesh = { subMeshes: sourceMesh.subMeshes };
  assert.equal(resolveBabylonMaterialPick([
    { hit: true, distance: 1, pickedMesh: foreignMesh, subMeshId: 17 },
  ] as never, viewport, 2, new Set()), null);

  const invalidViewport = { ...viewport, resolveMaterialIndex: () => 3 };
  assert.equal(resolveBabylonMaterialPick([
    { hit: true, distance: 1, pickedMesh: sourceMesh, subMeshId: 17 },
  ] as never, invalidViewport, 2, new Set()), null);
});

test("Babylon material click allows four pixels of jitter and rejects larger drags", () => {
  const candidate = {
    pointerId: 7,
    clientX: 10,
    clientY: 20,
    dragged: false,
  };
  assert.equal(babylonMaterialPointerMovedPastThreshold(candidate, {
    clientX: 14,
    clientY: 20,
  }), false);
  assert.equal(babylonMaterialPointerMovedPastThreshold(candidate, {
    clientX: 14,
    clientY: 21,
  }), true);
});

test("Babylon triangle predicate rejects hidden front submeshes before intersection", () => {
  const { sourceMesh, viewport } = selectionFixture();
  const visibleOnly = createBabylonVisibleMaterialTrianglePredicate(
    sourceMesh as never,
    viewport,
    2,
    new Set(),
  );
  assert.ok(visibleOnly);
  assert.equal(visibleOnly(null as never, null as never, null as never, null as never, 0, 1, 2), true);
  assert.equal(visibleOnly(null as never, null as never, null as never, null as never, 3, 4, 5), false);

  const hidden = createBabylonVisibleMaterialTrianglePredicate(
    sourceMesh as never,
    viewport,
    2,
    new Set([1]),
  );
  assert.ok(hidden);
  assert.equal(hidden(null as never, null as never, null as never, null as never, 0, 1, 2), false);
});
