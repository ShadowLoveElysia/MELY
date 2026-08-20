import type {
  PerformanceCapabilities,
  ResolvedNativeWorkerThreads,
} from "./performancePreferences";
import { normalizePerformanceCapabilities } from "./performancePreferences";
import { sha256Hex } from "./projectionContentHash";

export type NativeThreadRiskReason = "aboveRecommended" | "aboveMemorySuggestion";

export interface NativeThreadExecutionSnapshot {
  readonly backend: "native-rayon";
  readonly workerThreads: number;
  readonly recommendedThreads: number;
  readonly maximumThreads: number;
  readonly memorySuggestedThreads: number | null;
}

export interface NativeThreadRiskInput {
  resolvedThreads: ResolvedNativeWorkerThreads;
  capabilities: PerformanceCapabilities;
  memorySuggestedThreads?: number | null;
  nativeJobAvailable: boolean;
}

export interface NativeThreadRiskAssessment {
  readonly reasons: readonly NativeThreadRiskReason[];
  readonly needsConfirmation: boolean;
  readonly fingerprint: string | null;
  readonly executionSnapshot: NativeThreadExecutionSnapshot | null;
}

const normalizeThreadCount = (value: unknown, maximumThreads: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(maximumThreads, Math.round(value)));
};

const normalizeMemorySuggestion = (value: unknown, maximumThreads: number) => (
  value === null || value === undefined
    ? null
    : normalizeThreadCount(value, maximumThreads)
);

const executionFingerprint = (snapshot: NativeThreadExecutionSnapshot) => {
  const canonical = JSON.stringify(["MELYNativeThreadExecution", 1, snapshot]);
  return `sha256:${sha256Hex(new TextEncoder().encode(canonical))}`;
};

const createExecutionSnapshot = (
  workerThreads: number,
  recommendedThreads: number,
  maximumThreads: number,
  memorySuggestedThreads: number | null,
): NativeThreadExecutionSnapshot => Object.freeze({
  backend: "native-rayon" as const,
  workerThreads,
  recommendedThreads,
  maximumThreads,
  memorySuggestedThreads,
});

/**
 * 线程风险只约束本次原生执行快照。Web 回退不会生成伪原生确认，
 * 超推荐或超内存建议也只要求确认，不会改写用户选定的线程数。
 */
export const assessNativeThreadRisk = ({
  resolvedThreads,
  capabilities,
  memorySuggestedThreads,
  nativeJobAvailable,
}: NativeThreadRiskInput): NativeThreadRiskAssessment => {
  if (!nativeJobAvailable) {
    return Object.freeze({
      reasons: Object.freeze([]),
      needsConfirmation: false,
      fingerprint: null,
      executionSnapshot: null,
    });
  }

  const normalizedCapabilities = normalizePerformanceCapabilities(capabilities);
  const maximumThreads = normalizedCapabilities.maximumThreads;
  const workerThreads = normalizeThreadCount(resolvedThreads.effectiveThreads, maximumThreads);
  const recommendedThreads = normalizeThreadCount(
    normalizedCapabilities.recommendedThreads,
    maximumThreads,
  );
  const normalizedMemorySuggestion = normalizeMemorySuggestion(
    memorySuggestedThreads,
    maximumThreads,
  );
  const reasons: NativeThreadRiskReason[] = [];
  if (workerThreads > recommendedThreads) reasons.push("aboveRecommended");
  if (
    normalizedMemorySuggestion !== null
    && workerThreads > normalizedMemorySuggestion
  ) {
    reasons.push("aboveMemorySuggestion");
  }

  const executionSnapshot = createExecutionSnapshot(
    workerThreads,
    recommendedThreads,
    maximumThreads,
    normalizedMemorySuggestion,
  );
  return Object.freeze({
    reasons: Object.freeze(reasons),
    needsConfirmation: reasons.length > 0,
    fingerprint: executionFingerprint(executionSnapshot),
    executionSnapshot,
  });
};

/** 保留确认时的用户选定值，不根据建议值静默降档。 */
export const continueSelectedNativeThreadExecution = (
  assessment: NativeThreadRiskAssessment,
): NativeThreadExecutionSnapshot | null => {
  const snapshot = assessment.executionSnapshot;
  return snapshot === null
    ? null
    : createExecutionSnapshot(
        snapshot.workerThreads,
        snapshot.recommendedThreads,
        snapshot.maximumThreads,
        snapshot.memorySuggestedThreads,
      );
};

/**
 * 显式选择建议值时取 CPU 推荐、内存建议和当前选定值的最小值，
 * 因此这个风险缓解操作不会意外提高线程数。
 */
export const useRecommendedNativeThreadExecution = (
  assessment: NativeThreadRiskAssessment,
): NativeThreadExecutionSnapshot | null => {
  const snapshot = assessment.executionSnapshot;
  if (snapshot === null) return null;
  const workerThreads = Math.min(
    snapshot.workerThreads,
    snapshot.recommendedThreads,
    snapshot.memorySuggestedThreads ?? snapshot.maximumThreads,
  );
  return createExecutionSnapshot(
    workerThreads,
    snapshot.recommendedThreads,
    snapshot.maximumThreads,
    snapshot.memorySuggestedThreads,
  );
};
