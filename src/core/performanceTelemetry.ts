export const PERFORMANCE_TELEMETRY_SCHEMA_VERSION = 1 as const;

export type PerformanceTelemetryScope = "production-ui" | "validation";
export type PerformanceTelemetryWorkflow = "generation" | "export" | "generation-export";
export type PerformanceTelemetryBackend = "web-worker" | "tauri-native" | "node-validation";

export type PerformanceTelemetryStage =
  | "snapshot"
  | "preflight"
  | "voxelization.total"
  | "voxelization.scan"
  | "voxelization.texture"
  | "voxelization.fill"
  | "voxelization.match"
  | "ipc"
  | "preview"
  | "projection-document"
  | "litematic.nbt"
  | "litematic.gzip"
  | "write"
  | "validation.litematic-decode";

export type PerformanceStageOutcome = "completed" | "failed" | "cancelled";

export interface PerformanceTelemetryContext {
  scope: PerformanceTelemetryScope;
  workflow: PerformanceTelemetryWorkflow;
  backend: PerformanceTelemetryBackend;
  generationMode?: "solid" | "hologram";
  exportFormat?: "litematic" | "bundle" | "schematic" | "mcstructure" | "mcfunction";
  targetHeight?: number;
  workerThreads?: number;
}

export interface PerformanceStageMetrics {
  triangleCount?: number;
  candidateChecks?: number;
  blockCount?: number;
  chunkCount?: number;
  byteLength?: number;
  rssBytes?: number;
  cpuTimeMs?: number;
  activeThreads?: number;
  noProgressMs?: number;
  cancellationLatencyMs?: number;
}

export interface PerformanceStageMeasurement {
  sequence: number;
  stage: PerformanceTelemetryStage;
  startedAtMs: number;
  durationMs: number;
  outcome: PerformanceStageOutcome;
  metrics?: PerformanceStageMetrics;
}

export interface PerformanceTelemetryReport {
  schemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  context: PerformanceTelemetryContext;
  elapsedMs: number;
  stages: PerformanceStageMeasurement[];
}

export interface PerformanceStageSpan {
  end(
    outcome?: PerformanceStageOutcome,
    metrics?: PerformanceStageMetrics,
  ): PerformanceStageMeasurement;
}

export interface PerformanceTelemetryRecorder {
  start(stage: PerformanceTelemetryStage): PerformanceStageSpan;
  measure<T>(
    stage: PerformanceTelemetryStage,
    task: () => T,
    metrics?: (value: T) => PerformanceStageMetrics | undefined,
  ): T;
  measureAsync<T>(
    stage: PerformanceTelemetryStage,
    task: () => Promise<T>,
    metrics?: (value: T) => PerformanceStageMetrics | undefined,
  ): Promise<T>;
  report(): PerformanceTelemetryReport;
}

interface PerformanceTelemetryRecorderOptions extends PerformanceTelemetryContext {
  now?: () => number;
}

const VALIDATION_ONLY_STAGES = new Set<PerformanceTelemetryStage>([
  "validation.litematic-decode",
]);

const metricKeys = [
  "triangleCount",
  "candidateChecks",
  "blockCount",
  "chunkCount",
  "byteLength",
  "rssBytes",
  "cpuTimeMs",
  "activeThreads",
  "noProgressMs",
  "cancellationLatencyMs",
] as const satisfies readonly (keyof PerformanceStageMetrics)[];

const defaultNow = () => {
  if (typeof globalThis.performance?.now !== "function") {
    throw new Error("A monotonic performance clock is required.");
  }
  return globalThis.performance.now();
};

const finiteNonNegative = (value: number | undefined) => value !== undefined
  && Number.isFinite(value)
  && value >= 0
  ? value
  : undefined;

const finitePositiveInteger = (value: number | undefined) => value !== undefined
  && Number.isSafeInteger(value)
  && value > 0
  ? value
  : undefined;

/**
 * 遥测上下文仅复制固定的非识别字段，避免调用方通过扩展对象意外带入模型名或本地路径。
 */
const publicContext = (
  input: PerformanceTelemetryRecorderOptions,
): PerformanceTelemetryContext => ({
  scope: input.scope,
  workflow: input.workflow,
  backend: input.backend,
  ...(input.generationMode ? { generationMode: input.generationMode } : {}),
  ...(input.exportFormat ? { exportFormat: input.exportFormat } : {}),
  ...(finitePositiveInteger(input.targetHeight) !== undefined
    ? { targetHeight: input.targetHeight }
    : {}),
  ...(finitePositiveInteger(input.workerThreads) !== undefined
    ? { workerThreads: input.workerThreads }
    : {}),
});

/** 阶段指标同样使用白名单；异常文本、文件名和路径不属于性能合同。 */
const publicMetrics = (
  input: PerformanceStageMetrics | undefined,
): PerformanceStageMetrics | undefined => {
  if (!input) return undefined;
  const metrics: PerformanceStageMetrics = {};
  for (const key of metricKeys) {
    const value = finiteNonNegative(input[key]);
    if (value !== undefined) metrics[key] = value;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
};

const assertStageAllowed = (
  scope: PerformanceTelemetryScope,
  stage: PerformanceTelemetryStage,
) => {
  if (scope !== "validation" && VALIDATION_ONLY_STAGES.has(stage)) {
    throw new RangeError(`${stage} is restricted to validation telemetry.`);
  }
};

const cloneMeasurement = (
  measurement: PerformanceStageMeasurement,
): PerformanceStageMeasurement => ({
  ...measurement,
  ...(measurement.metrics ? { metrics: { ...measurement.metrics } } : {}),
});

export const createPerformanceTelemetryRecorder = (
  options: PerformanceTelemetryRecorderOptions,
): PerformanceTelemetryRecorder => {
  const context = publicContext(options);
  const sourceNow = options.now ?? defaultNow;
  let previousNow = Number.NEGATIVE_INFINITY;
  let sequence = 0;
  const measurements: PerformanceStageMeasurement[] = [];

  // 即使注入的宿主时钟短暂回退，也保证所有相对时间和阶段时长单调且非负。
  const monotonicNow = () => {
    const current = sourceNow();
    if (!Number.isFinite(current)) throw new RangeError("Performance clock returned a non-finite value.");
    previousNow = Math.max(previousNow, current);
    return previousNow;
  };

  const origin = monotonicNow();

  const start = (stage: PerformanceTelemetryStage): PerformanceStageSpan => {
    assertStageAllowed(context.scope, stage);
    const startedAt = monotonicNow();
    let ended = false;
    return {
      end: (outcome = "completed", metrics) => {
        if (ended) throw new Error(`Performance stage ${stage} has already ended.`);
        ended = true;
        const endedAt = monotonicNow();
        const safeMetrics = publicMetrics(metrics);
        const measurement: PerformanceStageMeasurement = {
          sequence,
          stage,
          startedAtMs: startedAt - origin,
          durationMs: endedAt - startedAt,
          outcome,
          ...(safeMetrics ? { metrics: safeMetrics } : {}),
        };
        sequence += 1;
        measurements.push(measurement);
        return cloneMeasurement(measurement);
      },
    };
  };

  const measure = <T>(
    stage: PerformanceTelemetryStage,
    task: () => T,
    metrics?: (value: T) => PerformanceStageMetrics | undefined,
  ) => {
    const span = start(stage);
    try {
      const value = task();
      span.end("completed", metrics?.(value));
      return value;
    } catch (error) {
      span.end("failed");
      throw error;
    }
  };

  const measureAsync = async <T>(
    stage: PerformanceTelemetryStage,
    task: () => Promise<T>,
    metrics?: (value: T) => PerformanceStageMetrics | undefined,
  ) => {
    const span = start(stage);
    try {
      const value = await task();
      span.end("completed", metrics?.(value));
      return value;
    } catch (error) {
      span.end("failed");
      throw error;
    }
  };

  return {
    start,
    measure,
    measureAsync,
    report: () => ({
      schemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
      context: { ...context },
      elapsedMs: monotonicNow() - origin,
      stages: measurements.map(cloneMeasurement),
    }),
  };
};
