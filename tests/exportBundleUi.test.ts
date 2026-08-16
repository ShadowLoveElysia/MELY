import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("project bundle extras are opt-in and forwarded to the exporter", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.match(source, /includeSchematic:\s*false/);
  assert.match(source, /includeMcstructure:\s*false/);
  assert.match(source, /includeMcfunction:\s*false/);
  assert.match(source, /exportCenter\.bundleFormats\.schematic/);
  assert.match(source, /exportCenter\.bundleFormats\.mcstructure/);
  assert.match(source, /exportCenter\.bundleFormats\.mcfunction/);
  assert.match(source, /const checked = event\.currentTarget\.checked;[\s\S]{0,120}\[option\]: checked/);
  assert.doesNotMatch(source, /\[option\]: event\.currentTarget\.checked/);
  assert.match(source, /includeSchematic:\s*request\.bundleFormats\?\.includeSchematic\s*\?\?\s*false/);
  assert.match(source, /includeMcstructure:\s*request\.bundleFormats\?\.includeMcstructure\s*\?\?\s*false/);
  assert.match(source, /includeMcfunction:\s*request\.bundleFormats\?\.includeMcfunction\s*\?\?\s*false/);
});

test("single projection exports use the canonical litematic extension and facial enhancement starts disabled", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.match(source, /faceDetail:\s*"off"/);
  assert.match(source, /request\.format === "litematic"[\s\S]*extension = "litematic"/);
  assert.doesNotMatch(source, /extension = "litematica"/);
});
