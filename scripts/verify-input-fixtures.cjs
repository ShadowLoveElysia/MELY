const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "..");
const pmdPath = resolve(process.argv[2] || `${projectRoot}/tests/fixtures/mely-input-e2e.pmd`);
const vmdPath = resolve(process.argv[3] || `${projectRoot}/tests/fixtures/mely-complex-motion-e2e.vmd`);
const reportPath = resolve(process.env.MELY_REPORT_PATH || `${tmpdir()}/mely-input-fixtures-report.json`);

const run = async () => {
  const parser = await import(pathToFileURL(resolve(
    projectRoot,
    "node_modules/@yohawing/three-mmd-loader/dist/parser/index.js",
  )).href);
  const pmdBytes = new Uint8Array(await readFile(pmdPath));
  const vmdBytes = new Uint8Array(await readFile(vmdPath));
  const pmdMetadata = parser.parsePmdMetadata(pmdBytes);
  const pmdInventory = parser.parsePmdSectionInventory(pmdBytes);
  const vmd = parser.parseVmd(vmdBytes);

  assert.equal(pmdMetadata.format, "pmd");
  assert.equal(pmdMetadata.counts.vertices, 16);
  assert.equal(pmdMetadata.counts.faces, 28);
  assert.equal(pmdMetadata.counts.materials, 1);
  assert.equal(pmdMetadata.counts.bones, 5);
  assert.equal(pmdMetadata.counts.iks, 1);
  assert.equal(pmdMetadata.counts.morphs, 2);
  assert.equal(pmdMetadata.trailingBytes, 0);
  assert.equal(vmd.metadata.maxFrame, 30);
  assert.equal(vmd.metadata.counts.bones, 12);
  assert.equal(vmd.metadata.counts.morphs, 3);
  assert.deepEqual(Object.keys(vmd.morphTracks), ["smile"]);

  const report = {
    pmd: {
      path: pmdPath,
      bytes: pmdBytes.byteLength,
      counts: pmdMetadata.counts,
      sections: pmdInventory.sections.map(({ name, count, byteLength }) => ({ name, count, byteLength })),
      trailingBytes: pmdMetadata.trailingBytes,
    },
    vmd: {
      path: vmdPath,
      bytes: vmdBytes.byteLength,
      metadata: vmd.metadata,
      boneTracks: Object.keys(vmd.boneTracks),
      morphTracks: Object.keys(vmd.morphTracks),
    },
    reportPath,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
