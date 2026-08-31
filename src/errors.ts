export const ExitCode = {
  Passed: 0,
  TestFailure: 1,
  InvalidInput: 2,
  StudioUnavailable: 3,
  StudioAmbiguous: 4,
  McpFailure: 5,
  Timeout: 6,
  Internal: 7,
  CleanupFailure: 8,
  Conflict: 9,
  Busy: 10,
  RecoveryRequired: 11,
  Interrupted: 12,
  Unsupported: 13,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode =
  | "ASSERTION_FAILED"
  | "CLEANUP_FAILED"
  | "CONFIG_INVALID"
  | "INTERNAL_ERROR"
  | "MCP_CAPABILITY_MISSING"
  | "MCP_CONNECTION_FAILED"
  | "PROJECT_NOT_FOUND"
  | "SPEC_INVALID"
  | "STUDIO_AMBIGUOUS"
  | "STUDIO_UNAVAILABLE"
  | "TIMEOUT"
  | "SESSION_CONFLICT"
  | "SESSION_BUSY"
  | "SESSION_RECOVERY_REQUIRED"
  | "INTERRUPTED"
  | "UNSUPPORTED"
  | "USAGE_ERROR";

export class RobloxAxiError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCodeValue;
  readonly suggestions: string[];
  readonly details?: unknown;

  constructor(options: {
    message: string;
    code: ErrorCode;
    exitCode: ExitCodeValue;
    suggestions?: string[];
    details?: unknown;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RobloxAxiError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.suggestions = options.suggestions ?? [];
    this.details = options.details;
  }
}

export function usageError(message: string, suggestions: string[] = []): RobloxAxiError {
  return new RobloxAxiError({
    message,
    code: "USAGE_ERROR",
    exitCode: ExitCode.InvalidInput,
    suggestions,
  });
}

export function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exitCodeForFailure(error: unknown): ExitCodeValue {
  return error instanceof RobloxAxiError ? error.exitCode : ExitCode.Internal;
}
