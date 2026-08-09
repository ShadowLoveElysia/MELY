const { readFile, writeFile } = require("node:fs/promises");
const {
  auditFaceDetailVariants,
  decodeLitematicFile,
  faceFrameFromSidecar,
} = require("./lib/face-detail-audit.cjs");

const args = process.argv.slice(2);
const positional = [];
let sidecarPath;
let reportPath;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--sidecar") sidecarPath = args[++index];
  else if (argument === "--report") reportPath = args[++index];
  else positional.push(argument);
}

if (positional.length !== 3 || !sidecarPath) {
  throw new Error(
    "Usage: node scripts/audit-face-detail.cjs <off.litematic> <balanced.litematic> <strong.litematic> --sidecar <solid-*.face.json> [--report <report.json>]",
  );
}

const run = async () => {
  const [offPath, balancedPath, strongPath] = positional;
  const [off, balanced, strong, sidecar] = await Promise.all([
    decodeLitematicFile(offPath),
    decodeLitematicFile(balancedPath),
    decodeLitematicFile(strongPath),
    readFile(sidecarPath, "utf8").then(JSON.parse),
  ]);
  const report = {
    format: "MELYFaceDetailAudit",
    version: 1,
    inputs: { off: offPath, balanced: balancedPath, strong: strongPath, sidecar: sidecarPath },
    files: {
      off: off.metadata,
      balanced: balanced.metadata,
      strong: strong.metadata,
    },
    ...auditFaceDetailVariants({
      off,
      balanced,
      strong,
      faceFrame: faceFrameFromSidecar(sidecar),
    }),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);
  if (!report.passed) process.exitCode = report.conclusive ? 1 : 2;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
