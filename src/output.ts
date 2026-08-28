import type { TestResult } from "./types.js";

export function compactRunResult(result: TestResult): Record<string, unknown> {
  return {
    run: result.run_id,
    test: result.test_id,
    status: result.status,
    duration: `${(result.duration_ms / 1_000).toFixed(1)}s`,
    assertions: `${result.assertions.passed} passed, ${result.assertions.failed} failed`,
    console: `${result.console.errors} errors, ${result.console.warnings} warnings`,
    evidence: result.evidence.directory,
    cleanup: result.cleanup.status,
    ...(result.failure === undefined
      ? {}
      : {
          failure: {
            code: result.failure.code,
            message: result.failure.message,
            step: result.failure.step,
            assertion: result.failure.assertion,
          },
          ...(result.console.excerpt === undefined ? {} : { console_excerpt: result.console.excerpt }),
          help: [`Run \`roblox-studio-axi test explain ${result.run_id}\``],
        }),
  };
}

export function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
