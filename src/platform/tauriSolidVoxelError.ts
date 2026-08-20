export type TauriSolidVoxelClientErrorKind =
  | "runtime-unavailable"
  | "transport"
  | "protocol"
  | "native";

export class TauriSolidVoxelClientError extends Error {
  readonly kind: TauriSolidVoxelClientErrorKind;
  readonly command: string;
  readonly nativeError?: {
    code: string;
    category: "validation" | "unsupported" | "cancelled" | "busy" | "internal";
    retryable: boolean;
    message?: string;
  };

  constructor(
    kind: TauriSolidVoxelClientErrorKind,
    command: string,
    message: string,
    options: { cause?: unknown; nativeError?: TauriSolidVoxelClientError["nativeError"] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TauriSolidVoxelClientError";
    this.kind = kind;
    this.command = command;
    this.nativeError = options.nativeError;
  }
}
