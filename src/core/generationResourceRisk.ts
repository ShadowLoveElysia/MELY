import type { GenerationMode } from "../types";
import type { ResourceEstimate } from "./resourceBudget";

export type GenerationResourceRiskReason = ResourceEstimate["reason"] | "largeWorkload";

export interface GenerationResourceRiskAssessment {
  requiresConfirmation: boolean;
  reason: GenerationResourceRiskReason;
  risks: GenerationResourceRiskReason[];
  estimatedCandidateChecks: number;
  minimumSeconds: number;
  maximumSeconds: number;
}

interface GenerationResourceRiskInput {
  mode: GenerationMode;
  targetHeight: number;
  triangleCount: number;
  estimate: ResourceEstimate;
}

const LARGE_SOLID_BLOCKS = 1_000_000;
const LARGE_SOLID_CANDIDATES = 4_000_000;

const finiteCount = (value: number) => Number.isFinite(value)
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(value)))
  : Number.MAX_SAFE_INTEGER;

/**
 * 主线程只能在快照前给出粗估；Worker 会使用变形后的三角面重新计算上界。
 * 实体模式按约四次候选检查/输出块展示，避免把输出块数误称为扫描工作量。
 */
export const assessGenerationResourceRisk = ({
  mode,
  targetHeight,
  triangleCount,
  estimate,
}: GenerationResourceRiskInput): GenerationResourceRiskAssessment => {
  const estimatedBlocks = finiteCount(estimate.estimatedBlocks);
  const reportedCandidates = finiteCount(estimate.estimatedCandidates);
  const estimatedCandidateChecks = mode === "solid"
    ? Math.max(reportedCandidates, finiteCount(estimatedBlocks * 4), finiteCount(triangleCount * 64))
    : reportedCandidates;
  const largeSolidWorkload = mode === "solid" && (
    targetHeight > 2_032
    || estimatedBlocks >= LARGE_SOLID_BLOCKS
    || estimatedCandidateChecks >= LARGE_SOLID_CANDIDATES
  );
  const reason: GenerationResourceRiskReason = estimate.reason !== "ok"
    ? estimate.reason
    : largeSolidWorkload ? "largeWorkload" : "ok";
  const risks: GenerationResourceRiskReason[] = [
    ...estimate.risks,
    ...(largeSolidWorkload ? ["largeWorkload" as const] : []),
  ].filter((risk, index, values) => values.indexOf(risk) === index);

  const candidateFastRate = mode === "solid" ? 1_500_000 : 3_000_000;
  const candidateSlowRate = mode === "solid" ? 200_000 : 800_000;
  const blockFastRate = mode === "solid" ? 200_000 : 400_000;
  const blockSlowRate = mode === "solid" ? 40_000 : 120_000;
  const minimumSeconds = Math.max(1, Math.ceil(Math.max(
    estimatedCandidateChecks / candidateFastRate,
    estimatedBlocks / blockFastRate,
  )));
  const maximumSeconds = Math.max(minimumSeconds, Math.ceil(Math.max(
    estimatedCandidateChecks / candidateSlowRate,
    estimatedBlocks / blockSlowRate,
  )));

  return {
    requiresConfirmation: estimate.requiresConfirmation || largeSolidWorkload,
    reason,
    risks,
    estimatedCandidateChecks,
    minimumSeconds,
    maximumSeconds,
  };
};
