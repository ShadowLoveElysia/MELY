import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { AppError } from "../src/core/appError";
import {
  expandMmdAssets,
  groupMmdMotionTrackCandidates,
  selectMmdMotionTrackCandidates,
} from "../src/core/mmdAssets";

test("ZIP model packages expand from a stream and preserve relative asset paths", async () => {
  const archive = new File([zipSync({
    "model/character.pmx": strToU8("pmx"),
    "model/textures/face.png": Uint8Array.of(1, 2, 3, 4),
  })], "character.zip", { type: "application/zip" });
  const files = await expandMmdAssets([archive]);
  assert.deepEqual(files.map((file) => file.webkitRelativePath).sort(), [
    "model/character.pmx",
    "model/textures/face.png",
  ]);
  assert.deepEqual(files.map((file) => file.size).sort((a, b) => a - b), [3, 4]);
});

test("invalid ZIP packages report a stable archive error code", async () => {
  const archive = new File([Uint8Array.of(
    0x50, 0x4b, 0x03, 0x04,
    0x14, 0x00,
    0x00, 0x00,
    0x63, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x00, 0x00,
    0x61,
    0x00,
  )], "broken.zip", {
    type: "application/zip",
  });

  await assert.rejects(expandMmdAssets([archive]), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.archive.invalid");
    return true;
  });
});

test("multi-VMD packages select compatible dance and expression tracks independently", () => {
  const facial = new File([Uint8Array.of(1)], "樱花草表情.vmd");
  const body = new File([Uint8Array.of(2)], "樱花草动作.vmd");
  const selected = selectMmdMotionTrackCandidates([
    {
      file: facial,
      path: "樱花草/樱花草表情.vmd",
      boneTrackCount: 0,
      morphTrackCount: 41,
      matchedBoneTrackCount: 0,
      matchedMorphTrackCount: 27,
      maxFrame: 608,
    },
    {
      file: body,
      path: "樱花草/樱花草动作.vmd",
      boneTrackCount: 57,
      morphTrackCount: 0,
      matchedBoneTrackCount: 57,
      matchedMorphTrackCount: 0,
      maxFrame: 629,
    },
  ]);

  assert.equal(selected.dance?.file, body);
  assert.equal(selected.dance?.matchedBoneTrackCount, 57);
  assert.equal(selected.expression?.file, facial);
  assert.equal(selected.expression?.matchedMorphTrackCount, 27);
});

test("a mixed VMD remains available in both motion selectors", () => {
  const mixed = new File([Uint8Array.of(1)], "mixed.vmd");
  const danceOnly = new File([Uint8Array.of(2)], "dance.vmd");
  const candidates = groupMmdMotionTrackCandidates([
    {
      file: mixed,
      path: "motions/mixed.vmd",
      boneTrackCount: 12,
      morphTrackCount: 8,
      matchedBoneTrackCount: 10,
      matchedMorphTrackCount: 7,
      maxFrame: 240,
    },
    {
      file: danceOnly,
      path: "motions/dance.vmd",
      boneTrackCount: 18,
      morphTrackCount: 0,
      matchedBoneTrackCount: 18,
      matchedMorphTrackCount: 0,
      maxFrame: 180,
    },
  ]);

  assert.deepEqual(candidates.dance.map((candidate) => candidate.file), [danceOnly, mixed]);
  assert.deepEqual(candidates.expression.map((candidate) => candidate.file), [mixed]);
});
