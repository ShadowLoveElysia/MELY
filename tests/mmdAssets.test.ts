import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { AppError } from "../src/core/appError";
import {
  expandMmdAssets,
  selectPrimaryMmdMotionCandidate,
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

test("multi-VMD packages prefer a compatible body motion over a facial-only motion", () => {
  const facial = new File([Uint8Array.of(1)], "樱花草表情.vmd");
  const body = new File([Uint8Array.of(2)], "樱花草动作.vmd");
  const selected = selectPrimaryMmdMotionCandidate([
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

  assert.equal(selected?.file, body);
  assert.equal(selected?.matchedBoneTrackCount, 57);
});
