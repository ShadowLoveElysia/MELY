import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeSolidVoxelSnapshotEnvelope } from "../src/core/solidVoxelSnapshotEnvelope";
import { createProjectionDocumentFromSolid } from "../src/core/projectionDocument";
import { createLitematicFromDocument } from "../src/core/litematic";
import { generateSolidVoxels } from "../src/core/solidVoxelizer";
import {
  createMotionSnapshot,
  createSnapshot,
  decodeLitematic,
  exportSafety,
  parsePmx,
  pmxEntries,
  selectPmxEntry,
  solidOptions,
  worldContractReport,
} from "./verify-real-4064-solid";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL_ZIP = "/mnt/h/Downloads/爱莉希雅—霁月婵娟2.0_by_神帝宇_ed5668c5d5c3b3063039ec8a4e83f102.zip";
const DEFAULT_VMD = "/mnt/h/Downloads/AAA动作.vmd";
const DEFAULT_OUTPUT_ROOT = resolve(projectRoot, "release-validation", "real-4064-native-solid");
const DEFAULT_THREADS = [1, 2, 4, 8];
const REQUIRED_FULL_THREADS = [1, 2, 4, 8];

const defaultOutput = () => {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return resolve(DEFAULT_OUTPUT_ROOT, `run-${timestamp}-${process.pid}`);
};
const DEFAULT_OUTPUT = defaultOutput();

const normalizeHostPath = (value: string) => {
  if (process.platform !== "win32") return value;
  const wslMount = value.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (!wslMount) return value;
  return `${wslMount[1].toUpperCase()}:\\${(wslMount[2] ?? "").replaceAll("/", "\\")}`;
};

interface CliOptions {
  modelZip: string;
  pmxEntry: string | null;
  vmd: string;
  danceFrame: number;
  expressionFrame: number;
  targetHeight: number;
  output: string;
  runner: string | null;
  threads: number[];
  smoke: boolean;
  overwrite: boolean;
}

interface RunnerResult {
  status: "passed" | "failed" | "blocked";
  workerThreads: number;
  jobId?: string;
  resultHandle?: { id: string; generation: string };
  manifest?: Record<string, unknown>;
  outputPath?: string;
  litematic?: {
    byteLength: number;
    blockCount: number;
    regionCount: number;
    paletteSize: number;
    dimensions: [number, number, number];
    dataVersion: number;
  };
  placement?: {
    relativeMinY: number;
    relativeMaxY: number;
    placementBottomY: number;
    placedMinY: number;
    placedMaxY: number;
    targetMinY: number;
    targetMaxY: number;
  };
  cpuCapabilities?: {
    physicalCores: number;
    logicalProcessors: number;
    availableParallelism: number;
    recommendedThreads: number;
    maximumThreads: number;
    physicalCountReliable: boolean;
  };
  error?: {
    code?: string;
    category?: string;
    retryable?: boolean;
    message: string;
  };
  timings?: {
    inputReadMs: number;
    createUploadMs: number;
    voxelizeMs: number;
    validateMs: number;
    litematicWriteMs: number;
    totalMs: number;
  };
}

const usage = `
真实 PMX + VMD 原生 4064 验收驱动

此脚本只负责生成一次真实姿态快照、调用 Rust validation runner，
以及用独立 NBT 解码器比较输出语义。没有 runner 时必须报告 blocked，
不会回退 TypeScript 体素化后伪造 native 通过。

用法:
  node --import tsx scripts/verify-native-real-4064-solid.ts --runner <runner> [options]

参数:
  --runner <path>          Rust runner 可执行文件（必填，或 MELY_NATIVE_RUNNER）
  --model-zip <path>       真实 PMX ZIP
  --pmx-entry <entry>      ZIP 内 PMX 路径/唯一后缀
  --vmd <path>             动作/表情 VMD
  --dance-frame <n>        动作帧（默认 300）
  --expression-frame <n>   表情帧（默认 300）
  --target-height <n>      默认 4064；--smoke 时可使用较小高度
  --threads <list>         线程列表，默认 1,2,4,8
  --output <directory>     输出目录
  --overwrite              显式允许替换该目录内同名验收产物
  --smoke                   标记为 smoke；完整验收仍要求 4064 + VMD
`;

const positive = (label: string, value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`${label} must be positive`);
  return parsed;
};

const nonNegative = (label: string, value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError(`${label} must be non-negative`);
  return parsed;
};

const parseCli = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    modelZip: normalizeHostPath(process.env.MELY_REAL_MODEL_ZIP ?? DEFAULT_MODEL_ZIP),
    pmxEntry: process.env.MELY_REAL_PMX_ENTRY ?? null,
    vmd: normalizeHostPath(process.env.MELY_REAL_VMD ?? DEFAULT_VMD),
    danceFrame: 300,
    expressionFrame: 300,
    targetHeight: 4_064,
    output: normalizeHostPath(process.env.MELY_NATIVE_OUTPUT ?? DEFAULT_OUTPUT),
    runner: process.env.MELY_NATIVE_RUNNER
      ? normalizeHostPath(process.env.MELY_NATIVE_RUNNER)
      : null,
    threads: [...DEFAULT_THREADS],
    smoke: false,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage.trim());
      process.exit(0);
    }
    if (argument === "--smoke") {
      options.smoke = true;
      continue;
    }
    if (argument === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) throw new RangeError(`${argument} requires a value`);
    if (argument === "--runner") options.runner = resolve(normalizeHostPath(next));
    else if (argument === "--model-zip") options.modelZip = resolve(normalizeHostPath(next));
    else if (argument === "--pmx-entry") options.pmxEntry = next.replaceAll("\\", "/");
    else if (argument === "--vmd") options.vmd = resolve(normalizeHostPath(next));
    else if (argument === "--dance-frame") options.danceFrame = nonNegative("danceFrame", next);
    else if (argument === "--expression-frame") options.expressionFrame = nonNegative("expressionFrame", next);
    else if (argument === "--target-height") options.targetHeight = positive("targetHeight", next);
    else if (argument === "--output") options.output = resolve(normalizeHostPath(next));
    else if (argument === "--threads") {
      options.threads = [...new Set(next.split(",").map((value) => positive("threads", value)))]
        .sort((left, right) => left - right);
    } else throw new RangeError(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.smoke && options.targetHeight !== 4_064) {
    throw new RangeError("Full native acceptance requires --target-height 4064; use --smoke for a smaller run");
  }
  if (!options.smoke && !options.vmd) throw new RangeError("Full native acceptance requires --vmd");
  if (options.threads.length === 0) throw new RangeError("At least one thread count is required");
  if (!options.smoke && (
    options.threads.length !== REQUIRED_FULL_THREADS.length
    || options.threads.some((value, index) => value !== REQUIRED_FULL_THREADS[index])
  )) {
    throw new RangeError("Full native acceptance requires exactly --threads 1,2,4,8 in that order");
  }
  return options;
};

const runnerArgs = (
  envelopePath: string,
  optionsPath: string,
  outputPath: string,
  threads: number,
  targetHeight: number,
  overwrite: boolean,
  smoke: boolean,
) => [
  "--snapshot", envelopePath,
  "--options", optionsPath,
  "--threads", String(threads),
  "--target-height", String(targetHeight),
  "--output", outputPath,
  ...(overwrite ? ["--overwrite"] : []),
  ...(smoke ? ["--smoke"] : []),
  "--json",
];

const runNative = async (
  runner: string,
  envelopePath: string,
  optionsPath: string,
  outputPath: string,
  threads: number,
  targetHeight: number,
  overwrite = false,
  smoke = false,
): Promise<RunnerResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      runner,
      runnerArgs(envelopePath, optionsPath, outputPath, threads, targetHeight, overwrite, smoke),
      { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const jsonLine = [...lines].reverse().find((line) => line.trimStart().startsWith("{"));
    if (!jsonLine) throw new Error(`runner produced no JSON result; stderr=${stderr}`);
    const result = JSON.parse(jsonLine) as RunnerResult;
    if (result.status !== "passed") return result;
    if (result.workerThreads !== threads) {
      throw new Error(`runner reported ${result.workerThreads} threads, requested ${threads}`);
    }
    return result;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const emitted = processError.stdout?.trim().split(/\r?\n/).filter(Boolean).pop();
    if (emitted?.startsWith("{")) {
      try {
        const parsed = JSON.parse(emitted) as RunnerResult;
        if (parsed.status === "blocked" || parsed.status === "failed") return parsed;
      } catch {
        // 保留原始进程错误，避免不完整 JSON 掩盖 runner 退出原因。
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: processError.code === "ENOENT" ? "blocked" : "failed",
      workerThreads: threads,
      error: {
        code: processError.code,
        message: processError.code === "ENOENT"
          ? `Native validation runner was not found: ${runner}`
          : message,
      },
    };
  }
};

const assertNativeOutput = async (
  result: RunnerResult,
  expected: { targetHeight: number; outputPath: string },
) => {
  if (result.status !== "passed") {
    throw new Error(result.error?.message ?? `native runner status: ${result.status}`);
  }
  assert.equal(result.outputPath, expected.outputPath);
  const bytes = new Uint8Array(await readFile(expected.outputPath));
  assert.ok(bytes.byteLength > 0, "native Litematic is empty");
  const decoded = decodeLitematic(bytes);
  assert.equal(decoded.version, 6);
  assert.equal(decoded.subVersion, 1);
  assert.equal(decoded.minecraftDataVersion, 3_465);
  assert.equal(decoded.enclosingSize[1], expected.targetHeight);
  assert.deepEqual(decoded.minimum, [0, 0, 0]);
  assert.deepEqual(
    decoded.maximum,
    decoded.enclosingSize.map((dimension) => dimension - 1),
    "decoded non-air bounds must fill the declared relative bounds",
  );
  assert.equal(decoded.totalNonAirBlocks, decoded.totalBlocks);
  assert.equal(decoded.regionCount, decoded.decodedRegionCount);
  if (!result.manifest || !result.litematic) {
    throw new Error("native runner passed without manifest or Litematic summary");
  }
  const manifest = result.manifest as {
    blockCount?: unknown;
    paletteSize?: unknown;
    dimensions?: unknown;
  };
  assert.equal(manifest.blockCount, decoded.totalBlocks);
  assert.deepEqual(manifest.dimensions, decoded.enclosingSize);
  assert.equal(result.litematic.blockCount, decoded.totalBlocks);
  assert.equal(result.litematic.regionCount, decoded.regionCount);
  assert.deepEqual(result.litematic.dimensions, decoded.enclosingSize);
  assert.equal(result.litematic.dataVersion, decoded.minecraftDataVersion);
  assert.equal(result.litematic.byteLength, bytes.byteLength);
  assert.equal(
    result.litematic.paletteSize,
    Number(manifest.paletteSize) + 1,
    "Litematic palette summary must include air exactly once",
  );
  const targetMinY = expected.targetHeight === 4_064 ? -2_032 : 0;
  const placementBottomY = targetMinY;
  const placedMinY = placementBottomY + (decoded.minimum?.[1] ?? Number.NaN);
  const placedMaxY = placementBottomY + (decoded.maximum?.[1] ?? Number.NaN);
  const targetMaxY = targetMinY + expected.targetHeight - 1;
  assert.equal(placedMinY, targetMinY);
  assert.equal(placedMaxY, targetMaxY);
  assert.deepEqual(result.placement, {
    relativeMinY: 0,
    relativeMaxY: expected.targetHeight - 1,
    placementBottomY,
    placedMinY,
    placedMaxY,
    targetMinY,
    targetMaxY,
  });
  return { bytes, decoded, placement: result.placement };
};

const pathExists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const measure = async <T>(operation: () => T | Promise<T>) => {
  const startedAt = performance.now();
  const value = await operation();
  return { value, elapsedMs: performance.now() - startedAt };
};

const assertCpuCapabilities = (result: RunnerResult) => {
  const capabilities = result.cpuCapabilities;
  if (!capabilities) throw new Error("native runner did not report CPU capabilities");
  for (const [label, value] of Object.entries({
    physicalCores: capabilities.physicalCores,
    logicalProcessors: capabilities.logicalProcessors,
    availableParallelism: capabilities.availableParallelism,
    recommendedThreads: capabilities.recommendedThreads,
    maximumThreads: capabilities.maximumThreads,
  })) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  }
  assert.ok(capabilities.physicalCores <= capabilities.logicalProcessors);
  assert.ok(capabilities.availableParallelism <= capabilities.logicalProcessors);
  assert.equal(
    capabilities.maximumThreads,
    Math.min(capabilities.physicalCores, capabilities.availableParallelism),
  );
  assert.ok(capabilities.recommendedThreads <= capabilities.maximumThreads);
  return capabilities;
};

const main = async (options = parseCli(process.argv.slice(2))) => {
  const startedAt = Date.now();
  const reportPath = resolve(options.output, "report.json");
  await mkdir(options.output, { recursive: true });
  const managedOutputs = [
    reportPath,
    resolve(options.output, "snapshot.mlysvox"),
    resolve(options.output, "solid-options.json"),
  ];
  if (!options.overwrite) {
    const existing = (await Promise.all(managedOutputs.map(async (path) => (
      await pathExists(path) ? path : null
    )))).filter((path): path is string => path !== null);
    if (existing.length > 0) {
      throw new Error(
        `Native validation artifacts already exist; use the default unique run directory, choose a new --output, or pass --overwrite: ${existing.join(", ")}`,
      );
    }
  }
  const reportBase: Record<string, unknown> & { status: string } = {
    status: "blocked",
    generatedAt: new Date().toISOString(),
    command: options,
    worldContract: worldContractReport(options.targetHeight),
    acceptance: {
      nativeRunnerRequired: true,
      independentNbtDecoder: true,
      requestedThreads: options.threads,
    },
  };
  if (!options.runner) {
    const report = {
      ...reportBase,
      reason: "native-runner-missing",
      message: "No Rust validation runner was supplied; native acceptance was not attempted.",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const archive = new Uint8Array(await readFile(options.modelZip));
  const entries = pmxEntries(archive);
  const selectedEntry = selectPmxEntry(entries, options.pmxEntry);
  const pmxBytes = entries[selectedEntry];
  const parsed = await parsePmx(pmxBytes);
  const motion = options.vmd
    ? await createMotionSnapshot(
      pmxBytes,
      options.vmd,
      options.danceFrame,
      options.expressionFrame,
    )
    : { snapshot: createSnapshot(parsed), report: null };
  if (!options.smoke) {
    if (!motion.report || motion.report.matchedMorphTrackCount <= 0) {
      throw new Error("Full native acceptance requires at least one compatible VMD morph track");
    }
    if (
      motion.report.requestedDanceFrame !== motion.report.appliedDanceFrame
      || motion.report.requestedExpressionFrame !== motion.report.appliedExpressionFrame
    ) {
      throw new Error("Full native acceptance requires requested action/expression frames to be applied without clamping");
    }
  }
  const snapshot = motion.snapshot;
  const solid = solidOptions(parsed, options.targetHeight);
  const baseline = await measure(() => generateSolidVoxels(
    snapshot,
    solid,
    undefined,
    { flatVoxelLimit: 0 },
  ));
  const baselineDocument = createProjectionDocumentFromSolid(baseline.value, {
    minecraftVersion: "1.20.1",
    metadata: { source: "native-acceptance-typescript-baseline" },
  });
  if (!baselineDocument.bounds) throw new Error("TypeScript baseline projection is empty");
  assert.equal(baselineDocument.bounds.dimensions[1], options.targetHeight);
  const baselineLitematic = await measure(() => createLitematicFromDocument(
    baselineDocument,
    {
      name: `MELY Native Baseline ${options.targetHeight}`,
      author: "MELY validation",
      description: `Native solid validation; target height ${options.targetHeight}`,
      timestamp: 1,
      regionMaxSize: 32,
      safety: exportSafety(options.targetHeight),
    },
  ));
  const baselineDecoded = await measure(() => decodeLitematic(baselineLitematic.value.bytes));
  const envelopePath = resolve(options.output, "snapshot.mlysvox");
  const outputEnvelope = encodeSolidVoxelSnapshotEnvelope(1n, snapshot);
  await writeFile(envelopePath, outputEnvelope);
  const optionsPath = resolve(options.output, "solid-options.json");
  await writeFile(optionsPath, `${JSON.stringify(solid, null, 2)}\n`);

  const runs: Array<Record<string, unknown>> = [];
  const semanticHashes: string[] = [];
  let cpuCapabilities: NonNullable<RunnerResult["cpuCapabilities"]> | null = null;
  let validationThreads = [...options.threads];
  try {
    const runThread = async (threads: number) => {
      const outputPath = resolve(options.output, `native-${threads}t.litematic`);
      if (!options.overwrite && await pathExists(outputPath)) {
        throw new Error(
          `Native validation artifact already exists; choose a new --output or pass --overwrite: ${outputPath}`,
        );
      }
      const nativeResult = await runNative(
        options.runner,
        envelopePath,
        optionsPath,
        outputPath,
        threads,
        options.targetHeight,
        options.overwrite,
        options.smoke,
      );
      const run: Record<string, unknown> = {
        requestedThreads: threads,
        native: nativeResult,
      };
      if (nativeResult.status === "passed") {
        const checked = await assertNativeOutput(nativeResult, { targetHeight: options.targetHeight, outputPath });
        semanticHashes.push(checked.decoded.semanticSha256);
        run.independentDecode = {
          byteLength: checked.bytes.byteLength,
          semanticSha256: checked.decoded.semanticSha256,
          totalBlocks: checked.decoded.totalBlocks,
          dimensions: checked.decoded.enclosingSize,
          regionCount: checked.decoded.regionCount,
          relativeBounds: {
            minimum: checked.decoded.minimum,
            maximum: checked.decoded.maximum,
          },
          placement: checked.placement,
        };
      }
      runs.push(run);
      return nativeResult;
    };

    const discoveryResult = await runThread(options.threads[0]);
    if (discoveryResult.status === "passed") {
      cpuCapabilities = assertCpuCapabilities(discoveryResult);
      if (!options.smoke && cpuCapabilities.maximumThreads < 8) {
        reportBase.status = "blocked";
        reportBase.reason = "hardware-thread-matrix-unavailable";
        reportBase.message = `Full native acceptance requires 1/2/4/8 threads, but this process can use at most ${cpuCapabilities.maximumThreads}`;
      } else {
        validationThreads = [
          ...options.threads,
          ...(options.threads.includes(cpuCapabilities.maximumThreads)
            ? []
            : [cpuCapabilities.maximumThreads]),
        ];
        for (const threads of validationThreads.slice(1)) await runThread(threads);
      }
    }
    const nativeStatuses = runs.map((run) => (run.native as RunnerResult).status);
    if (reportBase.reason === "hardware-thread-matrix-unavailable") {
      // 保留明确的 blocked 结论，不能把低于 8 线程的机器报告为完整矩阵通过。
    } else if (nativeStatuses.some((status) => status === "blocked")) {
      reportBase.status = "blocked";
      reportBase.reason = "native-run-blocked";
    } else if (nativeStatuses.some((status) => status !== "passed")) {
      reportBase.status = "failed";
      reportBase.reason = "native-run-failed";
    } else {
      assert.ok(semanticHashes.length > 0);
      assert.equal(
        semanticHashes.length,
        validationThreads.length,
        "native acceptance did not produce one decoded output per required thread count",
      );
      assert.equal(new Set(semanticHashes).size, 1, "native thread-matrix outputs are not semantically identical");
      assert.equal(
        semanticHashes[0],
        baselineDecoded.value.semanticSha256,
        "native output does not match the TypeScript baseline semantic hash",
      );
      const manifests = runs.map((run) => JSON.stringify((run.native as RunnerResult).manifest));
      assert.equal(new Set(manifests).size, 1, "native thread-matrix manifests are not identical");
      reportBase.status = "passed";
    }
  } catch (error) {
    reportBase.status = "failed";
    reportBase.reason = error instanceof Error ? error.message : String(error);
  }
  const report: Record<string, unknown> & { status: string } = {
    ...reportBase,
    elapsedMs: Date.now() - startedAt,
    source: {
      modelZip: options.modelZip,
      pmxEntry: selectedEntry,
      vmd: options.vmd,
      snapshotEnvelope: envelopePath,
      pmxByteLength: pmxBytes.byteLength,
      pmxMetadata: parsed.metadata,
    },
    motion: motion.report,
    options: solid,
    runs,
    semanticParity: {
      hashes: semanticHashes,
      equal: semanticHashes.length > 0 && new Set(semanticHashes).size === 1,
      typescriptBaselineHash: baselineDecoded.value.semanticSha256,
      matchesTypescriptBaseline: semanticHashes.length > 0
        && semanticHashes.every((hash) => hash === baselineDecoded.value.semanticSha256),
    },
    threadMatrix: {
      requiredBaseThreads: options.threads,
      validationThreads,
      cpuCapabilities,
      includesHardwareMaximum: cpuCapabilities !== null
        && validationThreads.includes(cpuCapabilities.maximumThreads),
    },
    typescriptBaseline: {
      storage: baseline.value.storage,
      blockCount: baseline.value.stats.blockCount,
      dimensions: baseline.value.stats.dimensions,
      chunkCount: baseline.value.chunks?.length ?? 0,
      paletteSize: baseline.value.palette.length,
      semanticSha256: baselineDecoded.value.semanticSha256,
      measurements: {
        voxelizationMs: baseline.elapsedMs,
        litematicMs: baselineLitematic.elapsedMs,
        decodeMs: baselineDecoded.elapsedMs,
      },
    },
    limitations: [
      "The deterministic CLI pose uses IK with physics disabled.",
      "The CLI snapshot omits texture decoding; UI texture-capture fidelity remains a separate acceptance path.",
      "Minecraft Java 1.20.1 datapack and Litematica loading remains a user in-game acceptance step.",
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, reportPath, runs: runs.length }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
};

const invokedDirectly = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    let options: CliOptions | null = null;
    try {
      options = parseCli(process.argv.slice(2));
    } catch {
      // CLI 本身非法时没有可信输出路径，只保留标准错误和非零退出码。
    }
    const failure = {
      status: "failed",
      generatedAt: new Date().toISOString(),
      reason: "driver-failed",
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "UnknownError", message: String(error) },
    };
    if (options) {
      await mkdir(options.output, { recursive: true });
      const failureReportPath = resolve(options.output, "report.json");
      if (options.overwrite || !await pathExists(failureReportPath)) {
        await writeFile(
          failureReportPath,
          `${JSON.stringify({ ...failure, command: options }, null, 2)}\n`,
        );
      }
    }
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}

export { assertNativeOutput, main, parseCli, runNative };
