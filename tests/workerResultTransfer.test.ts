import assert from "node:assert/strict";
import { test } from "node:test";
import { projectionResultTransferables } from "../src/core/workerResultTransfer";
import type { SolidVoxelResult } from "../src/types";

test("chunked solid worker results transfer every owned typed buffer", () => {
  const chunkPositions = new Uint16Array([1, 9]);
  const chunkBlocks = new Uint16Array([0, 1]);
  const result: SolidVoxelResult = {
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [{ chunk: [0, 0, 0], positions: chunkPositions, blockIndices: chunkBlocks }],
    palette: [],
    stats: {
      blockCount: 2,
      surfaceBlockCount: 2,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 2,
      paletteSize: 0,
      dimensions: [2, 1, 1],
    },
    bounds: { min: [0, 0, 0], max: [1, 0, 0] },
  };

  assert.deepEqual(projectionResultTransferables(result), [
    result.positions.buffer,
    result.blockIndices.buffer,
    chunkPositions.buffer,
    chunkBlocks.buffer,
  ]);
});
