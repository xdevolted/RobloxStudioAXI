import fg from "fast-glob";
import { relative } from "node:path";
import { ExitCode, RobloxAxiError } from "../errors.js";
import { loadPlaytestSpec } from "../project/load-spec.js";
import type { ResolvedProjectConfig, StudioInstance, TestResult, WorkflowSpec } from "../types.js";
import type { StudioService } from "../studio/service.js";
import { runPlaytest } from "./test-runner.js";

export interface WorkflowOutcome {
  name: string;
  status: "passed" | "failed";
  tests: TestResult[];
  exitCode: number;
}

export async function resolveWorkflowTests(
  config: ResolvedProjectConfig,
  workflow: WorkflowSpec,
): Promise<string[]> {
  const files = await fg(workflow.tests.include, {
    cwd: config.root,
    absolute: true,
    onlyFiles: true,
    ignore: workflow.tests.exclude ?? [],
    unique: true,
  });
  files.sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new RobloxAxiError({
      message: `Workflow ${workflow.name} matched 0 playtest specifications`,
      code: "SPEC_INVALID",
      exitCode: ExitCode.InvalidInput,
      suggestions: ["Run `roblox-studio-axi workflow list --full`"],
    });
  }
  return files;
}

export async function runWorkflow(options: {
  config: ResolvedProjectConfig;
  workflow: WorkflowSpec;
  service: StudioService;
  studio: StudioInstance;
  signal?: AbortSignal;
}): Promise<WorkflowOutcome> {
  const config: ResolvedProjectConfig = {
    ...options.config,
    evidence: {
      ...options.config.evidence,
      ...(options.workflow.evidence?.screenshots === undefined
        ? {}
        : { screenshots: options.workflow.evidence.screenshots }),
      ...(options.workflow.evidence?.console === undefined
        ? {}
        : { console: options.workflow.evidence.console }),
    },
  };
  const tests: TestResult[] = [];
  let exitCode: number = ExitCode.Passed;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const workflowTimeoutMs = options.workflow.execution?.timeout_seconds
    ? options.workflow.execution.timeout_seconds * 1_000
    : undefined;
  const timer =
    workflowTimeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new RobloxAxiError({
                message: `Workflow ${options.workflow.name} timed out after ${workflowTimeoutMs}ms`,
                code: "TIMEOUT",
                exitCode: ExitCode.Timeout,
              }),
            ),
          workflowTimeoutMs,
        );
  try {
    for (const path of await resolveWorkflowTests(config, options.workflow)) {
      const loaded = await loadPlaytestSpec(config, relative(config.root, path));
      const outcome = await runPlaytest({
        config,
        spec: loaded.spec,
        source: loaded.source,
        service: options.service,
        studio: options.studio,
        signal: controller.signal,
      });
      tests.push(outcome.result);
      exitCode = Math.max(exitCode, outcome.exitCode);
      if (
        controller.signal.aborted ||
        (outcome.exitCode !== ExitCode.Passed && (options.workflow.execution?.fail_fast ?? true))
      ) {
        break;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
  return {
    name: options.workflow.name,
    status: exitCode === ExitCode.Passed ? "passed" : "failed",
    tests,
    exitCode,
  };
}
