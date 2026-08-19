import type { ProjectionResult, WorkerCommand } from "../types";
import { preflightGenerationHeight, preflightProjectionHeight } from "./heightSafety";

const baseInput = (command: WorkerCommand) => ({
  versionId: command.versionId ?? "",
  heightMode: command.heightMode ?? "default" as const,
  targetHeight: command.options.targetHeight,
  targetDimension: command.targetDimension,
  datapackAcknowledged: command.datapackAcknowledged,
  confirmations: command.confirmations,
  configurationFingerprint: command.configurationFingerprint,
});

export const assertWorkerGenerationHeight = (command: WorkerCommand) => {
  const preflight = preflightGenerationHeight(baseInput(command));
  if (!preflight.allowed) {
    throw new RangeError(preflight.errorCode ?? "Invalid generation height");
  }
  return preflight;
};

export const assertWorkerResultHeight = (
  command: WorkerCommand,
  result: Pick<ProjectionResult, "bounds">,
) => {
  const preflight = preflightProjectionHeight({
    ...baseInput(command),
    bounds: result.bounds,
    placementBottomY: command.placementBottomY ?? Number.NaN,
    targetDimension: command.targetDimension,
    requireExtremeExportConfirmation: false,
  });
  if (!preflight.allowed) {
    throw new RangeError(preflight.errorCode ?? "Invalid generated height");
  }
  return preflight;
};
