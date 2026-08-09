import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, appError, errorDescriptor } from "../src/core/appError";

test("AppError exposes stable localization data while retaining its diagnostic cause", () => {
  const cause = new Error("third-party parser detail");
  const error = appError("error.model.loadFailed", undefined, cause);

  assert.ok(error instanceof AppError);
  assert.equal(error.message, "error.model.loadFailed");
  assert.equal(error.cause, cause);
  assert.deepEqual(errorDescriptor(error), { code: "error.model.loadFailed", params: undefined });
});

test("unknown exceptions never expose their message through the default descriptor", () => {
  assert.deepEqual(
    errorDescriptor(new Error("unlocalized internal detail")),
    { code: "error.unknown" },
  );
  assert.deepEqual(
    errorDescriptor(new RangeError("another internal invariant"), {
      code: "error.export.failed",
    }),
    { code: "error.export.failed" },
  );
});
