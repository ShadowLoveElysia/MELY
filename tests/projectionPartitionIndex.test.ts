import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectionChunk, ProjectionDocument } from "../src/types";
import { createProjectionDocument } from "../src/core/projectionDocument";
import { createProjectionViewContentHash } from "../src/core/projectionContentHash";
import {
  createProjectionPartitionIndex,
  iterateProjectionPartitionBlocks,
} from "../src/core/projectionPartitionIndex";
import { planExportBundle } from "../src/core/exportBundle";

const key = (position: readonly number[]) => position.join(",");

const indexedDocument = () => createProjectionDocument([
  { position: [-33, -1, -1], paletteIndex: 0 },
  { position: [-32, 0, 0], paletteIndex: 1 },
  { position: [-1, 31, 31], paletteIndex: 0 },
  { position: [0, 32, 32], paletteIndex: 1 },
  { position: [31, 63, 63], paletteIndex: 0 },
  { position: [32, 64, 64], paletteIndex: 1 },
  { position: [63, 95, 95], paletteIndex: 0 },
  { position: [64, 96, 96], paletteIndex: 1 },
], [
  { blockId: "minecraft:white_concrete" },
  { blockId: "minecraft:black_concrete" },
]);

test("partition index assigns every negative and boundary block exactly once", () => {
  const document = indexedDocument();
  const index = createProjectionPartitionIndex(document, [32, 32, 32]);
  const source = new Map<string, number>();
  for (const chunk of document.chunks) {
    for (let offset = 0; offset < chunk.positions.length; offset += 1) {
      const local = chunk.positions[offset];
      const x = local % 32;
      const yz = Math.floor(local / 32);
      const y = Math.floor(yz / 32);
      const z = yz % 32;
      source.set(key([
        chunk.chunk[0] * 32 + x,
        chunk.chunk[1] * 32 + y,
        chunk.chunk[2] * 32 + z,
      ]), chunk.paletteIndices[offset]);
    }
  }

  const reconstructed = new Map<string, number>();
  for (let part = 0; part < index.views.length; part += 1) {
    for (const block of iterateProjectionPartitionBlocks(document, index, part)) {
      const positionKey = key(block.position);
      assert.equal(reconstructed.has(positionKey), false, `duplicate block ${positionKey}`);
      reconstructed.set(positionKey, block.paletteIndex);
    }
  }

  assert.deepEqual(
    [...reconstructed].sort(([left], [right]) => left.localeCompare(right)),
    [...source].sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.equal(index.blockCount, document.blockCount);
  assert.equal(index.scanStats.sourceChunksVisited, document.chunks.length);
  assert.equal(index.scanStats.sourceBlocksVisited, document.blockCount);
  assert.ok(index.scanStats.candidateReferences >= index.views.length);
  assert.ok(index.scanStats.candidateReferences < document.chunks.length * index.views.length);
});

test("indexed partition iteration is equivalent to the unindexed view iterator and preserves hashes", () => {
  const document = indexedDocument();
  const index = createProjectionPartitionIndex(document);

  for (const view of index.views) {
    const indexed = [...iterateProjectionPartitionBlocks(document, index, view)]
      .map((block) => `${key(block.position)}:${block.paletteIndex}`)
      .sort();
    const unindexed = [...document.chunks].flatMap((chunk) => {
      const values: string[] = [];
      for (let offset = 0; offset < chunk.positions.length; offset += 1) {
        const local = chunk.positions[offset];
        const x = local % 32;
        const yz = Math.floor(local / 32);
        const y = Math.floor(yz / 32);
        const z = yz % 32;
        const position: [number, number, number] = [
          chunk.chunk[0] * 32 + x,
          chunk.chunk[1] * 32 + y,
          chunk.chunk[2] * 32 + z,
        ];
        if (position.every((value, axis) =>
          value >= view.bounds.min[axis] && value <= view.bounds.max[axis])) {
          values.push(`${key(position)}:${chunk.paletteIndices[offset]}`);
        }
      }
      return values;
    }).sort();
    assert.deepEqual(indexed, unindexed, `partition ${key(view.index)} differs`);
    assert.equal(
      createProjectionViewContentHash(document, view),
      createProjectionViewContentHash(document, view, index),
    );
  }
});

test("partition index tolerates empty source chunks without inventing blocks", () => {
  const source = indexedDocument();
  const emptyChunk: ProjectionChunk = {
    chunk: [99, 99, 99],
    positions: new Uint16Array(),
    paletteIndices: new Uint16Array(),
  };
  const document: ProjectionDocument = {
    ...source,
    chunks: [...source.chunks, emptyChunk],
  };
  const index = createProjectionPartitionIndex(document);

  assert.equal(index.sourceChunkCount, source.chunks.length + 1);
  assert.equal(index.scanStats.sourceChunksVisited, source.chunks.length + 1);
  assert.equal(index.scanStats.sourceBlocksVisited, source.blockCount);
  assert.equal(
    index.candidateChunkIndices.some((chunks) => chunks.includes(source.chunks.length)),
    false,
  );
});

test("partition index validates typed-array shape before scanning", () => {
  const source = indexedDocument();
  const malformed: ProjectionDocument = {
    ...source,
    chunks: [{
      ...source.chunks[0],
      paletteIndices: new Uint16Array(source.chunks[0].paletteIndices.length + 1),
    }, ...source.chunks.slice(1)],
  };
  assert.throws(
    () => createProjectionPartitionIndex(malformed),
    /Projection chunk 0 has inconsistent buffers/,
  );
});

test("bundle planning exposes one shared index while keeping it out of the public plan shape", () => {
  const document = createProjectionDocument([
    { position: [-1, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const prepared = planExportBundle(document, { name: "indexed plan" });

  assert.strictEqual(prepared.plan.partitionIndex, prepared.partitionIndex);
  assert.equal(Object.keys(prepared.plan).includes("partitionIndex"), false);
  assert.equal(prepared.partitionIndex.scanStats.sourceBlocksVisited, document.blockCount);
  assert.deepEqual(
    prepared.plan.parts.map((part) => part.blockCount),
    prepared.partitionIndex.views.map((view) => view.blockCount),
  );
});

test("custom partition dimensions retain floor-relative boundaries", () => {
  const document = createProjectionDocument([
    { position: [-5, -6, -7], paletteIndex: 0 },
    { position: [-2, -2, -1], paletteIndex: 0 },
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 3, 6], paletteIndex: 0 },
    { position: [2, 4, 7], paletteIndex: 0 },
  ], [{ blockId: "minecraft:stone" }]);
  const index = createProjectionPartitionIndex(document, [3, 4, 5]);
  const reconstructed = [...index.views].flatMap((_, part) =>
    [...iterateProjectionPartitionBlocks(document, index, part)].map((block) => key(block.position)));

  assert.equal(new Set(reconstructed).size, document.blockCount);
  assert.equal(reconstructed.length, document.blockCount);
  assert.deepEqual(index.views.map((view) => view.index), [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
  ]);
});
