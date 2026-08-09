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
