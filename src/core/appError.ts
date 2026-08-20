import type { TranslationKey } from "../i18n";

export type AppErrorParams = Record<string, string | number>;
export type AppErrorCode = Extract<TranslationKey, `error.${string}`>;

export interface AppErrorDescriptor {
  code: AppErrorCode;
  params?: AppErrorParams;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly params?: AppErrorParams;
  override readonly cause?: unknown;

  constructor(code: AppErrorCode, params?: AppErrorParams, cause?: unknown) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.params = params;
    this.cause = cause;
  }
}

export const appError = (code: AppErrorCode, params?: AppErrorParams, cause?: unknown) => (
  new AppError(code, params, cause)
);

export const errorDescriptor = (
  error: unknown,
  fallback: AppErrorDescriptor = { code: "error.unknown" },
): AppErrorDescriptor => error instanceof AppError
  ? { code: error.code, params: error.params }
  : fallback;

/** 原生边界保留可安全展示的 command 错误信息，避免统一退化为“未知错误”。 */
const WORKER_MEMORY_ERROR_PATTERNS = [
  /map maximum size/i,
  /invalid (?:array|typed array) length/i,
  /array buffer allocation failed/i,
  /allocation failed/i,
  /out of memory/i,
  /heap limit/i,
] as const;

/** Worker 边界只输出稳定错误码，异常原文仅用于本地分类，不进入 UI 或跨线程消息。 */
export const workerErrorDescriptor = (value: unknown): AppErrorDescriptor => {
  if (value instanceof AppError) return { code: value.code, params: value.params };
  if (value instanceof RangeError) {
    return {
      code: WORKER_MEMORY_ERROR_PATTERNS.some((pattern) => pattern.test(value.message))
        ? "error.worker.outOfMemory"
        : "error.worker.range",
    };
  }
  return { code: "error.worker.failed" };
};
