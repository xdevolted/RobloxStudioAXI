import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ExitCode, RobloxAxiError, exitCodeForFailure, messageFromUnknown } from "../errors.js";
import { RunArtifacts } from "../evidence/artifacts.js";
import { assertSafeTestEnvironment } from "../project/load-config.js";
import type {
  AssertionResult,
  ConsoleEntry,
  PlaytestAssertion,
  PlaytestSpec,
  PlaytestStep,
  ResolvedProjectConfig,
  StudioInstance,
  TestResult,
} from "../types.js";
import type { StudioService } from "../studio/service.js";
import { consoleDelta } from "../studio/service.js";
import { resolveTarget } from "../targeting/resolver.js";
import { evaluateAssertion } from "./assertions.js";
import { withTimeout } from "./timeout.js";

export interface RunPlaytestOptions {
  config: ResolvedProjectConfig;
  spec: PlaytestSpec;
  source: string;
  service: StudioService;
  studio: StudioInstance;
  signal?: AbortSignal;
}

export interface RunPlaytestOutcome {
  result: TestResult;
  exitCode: number;
  artifactDirectory: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RobloxAxiError) throw signal.reason;
  throw new RobloxAxiError({
    message: "Playtest was interrupted",
    code: "INTERNAL_ERROR",
    exitCode: ExitCode.Internal,
  });
}

export function validateSpecSemantics(spec: PlaytestSpec): void {
  const ids = new Set<string>();
  for (const [index, step] of spec.steps.entries()) {
    const id = step.id ?? `step-${index + 1}`;
    if (ids.has(id)) {
      throw new RobloxAxiError({
        message: `Duplicate step id: ${id}`,
        code: "SPEC_INVALID",
        exitCode: ExitCode.InvalidInput,
      });
    }
    ids.add(id);
    if (step.action === "execute_luau" && Boolean(step.code) === Boolean(step.file)) {
      throw new RobloxAxiError({
        message: `${id} must set exactly one of code or file`,
        code: "SPEC_INVALID",
        exitCode: ExitCode.InvalidInput,
      });
    }
  }
  for (const assertion of spec.assertions ?? []) {
    if (assertion.after_step && !ids.has(assertion.after_step)) {
      throw new RobloxAxiError({
        message: `Assertion references unknown after_step: ${assertion.after_step}`,
        code: "SPEC_INVALID",
        exitCode: ExitCode.InvalidInput,
      });
    }
  }
}

async function codeForStep(step: Extract<PlaytestStep, { action: "execute_luau" }>, root: string) {
  if (step.code) return step.code;
  if (!step.file) throw new Error("Validated execute_luau step has no source");
  return readFile(isAbsolute(step.file) ? step.file : resolve(root, step.file), "utf8");
}

async function runStep(options: {
  step: PlaytestStep;
  config: ResolvedProjectConfig;
  service: StudioService;
  studioId: string;
  artifacts: RunArtifacts;
  screenshots: string[];
}): Promise<unknown> {
  const { step, config, service, studioId } = options;
  switch (step.action) {
    case "wait":
      await new Promise((resolvePromise) => setTimeout(resolvePromise, step.duration_ms));
      return { waited_ms: step.duration_ms };
    case "wait_for_state":
      return service.waitForState(
        studioId,
        step.state,
        (step.timeout_seconds ?? config.studio.operationTimeoutMs / 1_000) * 1_000,
      );
    case "wait_for_player":
      await service.waitForPlayer(
        studioId,
        (step.timeout_seconds ?? config.studio.operationTimeoutMs / 1_000) * 1_000,
      );
      return true;
    case "start_play": {
      const changed = await service.startPlay(studioId);
      await service.waitForState(studioId, "play", config.studio.operationTimeoutMs);
      return { changed, state: "play" };
    }
    case "stop_play": {
      const changed = await service.stopPlay(studioId);
      await service.waitForState(studioId, "edit", config.studio.operationTimeoutMs);
      return { changed, state: "edit" };
    }
    case "execute_luau":
      return service.executeLuau(studioId, step.context, await codeForStep(step, config.root));
    case "console_capture":
      return service.getConsoleOutput(studioId);
    case "capture": {
      const screenshot = await service.captureScreen(studioId, step.label);
      const path = await options.artifacts.writeScreenshot(step.label, screenshot);
      options.screenshots.push(path);
      return { path };
    }
    case "navigate": {
      let instancePath: string | undefined;
      if (step.target) {
        const target = await resolveTarget(service, studioId, step.target);
        if (target.coordinates) {
          throw new RobloxAxiError({
            message: "Character navigation requires a 3D position or instance target",
            code: "SPEC_INVALID",
            exitCode: ExitCode.InvalidInput,
          });
        }
        instancePath = target.instancePath;
      }
      return service.navigateCharacter(studioId, {
        ...(step.position === undefined ? {} : { position: step.position }),
        ...(instancePath === undefined ? {} : { instancePath }),
        ...(step.speed_multiplier === undefined ? {} : { speedMultiplier: step.speed_multiplier }),
      });
    }
    case "keyboard": {
      if (!step.target) return service.sendKeyboardInput(studioId, step.sequence);
      const target = await resolveTarget(service, studioId, step.target);
      if (!target.instancePath) {
        throw new RobloxAxiError({
          message: "Keyboard input requires an instance target",
          code: "SPEC_INVALID",
          exitCode: ExitCode.InvalidInput,
        });
      }
      return service.sendKeyboardInput(
        studioId,
        step.sequence.map((action) => ({ instance_path: target.instancePath, ...action })),
      );
    }
    case "mouse": {
      if (!step.target) return service.sendMouseInput(studioId, step.sequence);
      const target = await resolveTarget(service, studioId, step.target);
      return service.sendMouseInput(
        studioId,
        step.sequence.map((action) => ({
          ...(target.instancePath ? { instance_path: target.instancePath } : target.coordinates),
          ...action,
        })),
      );
    }
  }
}

async function evaluateAssertions(options: {
  assertions: Array<{ assertion: PlaytestAssertion; index: number }>;
  values: Map<string, unknown>;
  consoleEntries: ConsoleEntry[];
  service: StudioService;
  studioId: string;
  config: ResolvedProjectConfig;
  results: AssertionResult[];
}): Promise<void> {
  for (const { assertion, index } of options.assertions) {
    const result = await evaluateAssertion(assertion, index, options);
    options.results.push(result);
    if (!result.passed) {
      throw new RobloxAxiError({
        message: result.message,
        code: "ASSERTION_FAILED",
        exitCode: ExitCode.TestFailure,
        details: result,
      });
    }
  }
}

export async function runPlaytest(options: RunPlaytestOptions): Promise<RunPlaytestOutcome> {
  assertSafeTestEnvironment(options.config);
  validateSpecSemantics(options.spec);
  const artifacts = await RunArtifacts.create(options.config);
  const startedAt = new Date();
  const screenshots: string[] = [];
  const assertionResults: AssertionResult[] = [];
  const values = new Map<string, unknown>();
  let baselineConsole: ConsoleEntry[] = [];
  let newConsole: ConsoleEntry[] = [];
  let lastStudioState: string | null = null;
  let failure: unknown;
  let failureStep: number | null = null;
  let failureAssertion: string | null = null;
  let cleanupStatus: TestResult["cleanup"] = { status: "not_needed", stop_attempted: false };

  await artifacts.writeManifest({
    testId: options.spec.id,
    source: options.source,
    studioId: options.studio.id,
    ...(options.studio.placeId === undefined ? {} : { placeId: options.studio.placeId }),
    startedAt: startedAt.toISOString(),
  });

  try {
    throwIfAborted(options.signal);
    options.service.require([
      "get_studio_state",
      "start_stop_play",
      "execute_luau",
      "get_console_output",
      "screen_capture",
    ]);
    const initialState = await options.service.getStudioState(options.studio.id);
    lastStudioState = initialState.mode;
    baselineConsole = await options.service.getConsoleOutput(options.studio.id);

    const setupMode = options.spec.setup?.mode ?? "play";
    const setupTimeoutMs = (options.spec.setup?.timeout_seconds ?? 60) * 1_000;
    if (setupMode === "play" && initialState.mode !== "play") {
      await options.service.startPlay(options.studio.id);
      lastStudioState = (await options.service.waitForState(options.studio.id, "play", setupTimeoutMs)).mode;
    } else if (setupMode === "edit" && initialState.mode !== "edit") {
      await options.service.stopPlay(options.studio.id);
      lastStudioState = (await options.service.waitForState(options.studio.id, "edit", setupTimeoutMs)).mode;
    }

    for (const [index, step] of options.spec.steps.entries()) {
      throwIfAborted(options.signal);
      failureStep = index + 1;
      const stepId = step.id ?? `step-${index + 1}`;
      const value = await withTimeout(
        `step ${index + 1} (${step.action})`,
        (step.timeout_seconds ?? options.config.studio.operationTimeoutMs / 1_000) * 1_000,
        () =>
          runStep({
            step,
            config: options.config,
            service: options.service,
            studioId: options.studio.id,
            artifacts,
            screenshots,
          }),
      );
      values.set(stepId, value);
      const due = (options.spec.assertions ?? [])
        .map((assertion, assertionIndex) => ({ assertion, index: assertionIndex }))
        .filter(({ assertion }) => assertion.after_step === stepId);
      if (due.length > 0) {
        newConsole = consoleDelta(baselineConsole, await options.service.getConsoleOutput(options.studio.id));
        await evaluateAssertions({
          assertions: due,
          values,
          consoleEntries: newConsole,
          service: options.service,
          studioId: options.studio.id,
          config: options.config,
          results: assertionResults,
        });
      }
    }

    failureStep = null;
    throwIfAborted(options.signal);
    newConsole = consoleDelta(baselineConsole, await options.service.getConsoleOutput(options.studio.id));
    const finalAssertions = (options.spec.assertions ?? [])
      .map((assertion, index) => ({ assertion, index }))
      .filter(({ assertion }) => !assertion.after_step);
    await evaluateAssertions({
      assertions: finalAssertions,
      values,
      consoleEntries: newConsole,
      service: options.service,
      studioId: options.studio.id,
      config: options.config,
      results: assertionResults,
    });
  } catch (error) {
    failure = error;
    if (error instanceof RobloxAxiError && error.details && typeof error.details === "object") {
      const id = (error.details as { id?: unknown }).id;
      if (typeof id === "string") failureAssertion = id;
    }
    if (options.config.evidence.screenshots === "on_failure") {
      try {
        const screenshot = await options.service.captureScreen(options.studio.id, "failure");
        screenshots.push(await artifacts.writeScreenshot("failure", screenshot));
      } catch (captureError) {
        const suffix = `Failure screenshot also failed: ${messageFromUnknown(captureError)}`;
        failure = new RobloxAxiError({
          message: `${messageFromUnknown(failure)}. ${suffix}`,
          code: failure instanceof RobloxAxiError ? failure.code : "INTERNAL_ERROR",
          exitCode: exitCodeForFailure(failure),
          cause: failure,
        });
      }
    }
    try {
      newConsole = consoleDelta(baselineConsole, await options.service.getConsoleOutput(options.studio.id));
    } catch (consoleError) {
      const suffix = `Console evidence also failed: ${messageFromUnknown(consoleError)}`;
      failure = new RobloxAxiError({
        message: `${messageFromUnknown(failure)}. ${suffix}`,
        code: failure instanceof RobloxAxiError ? failure.code : "INTERNAL_ERROR",
        exitCode: exitCodeForFailure(failure),
        cause: failure,
      });
    }
  } finally {
    if (options.config.safety.alwaysStopPlaytest && options.spec.cleanup.stop_playtest) {
      cleanupStatus = { status: "passed", stop_attempted: true };
      try {
        await options.service.stopPlay(options.studio.id);
        lastStudioState = (
          await options.service.waitForState(
            options.studio.id,
            "edit",
            options.config.studio.operationTimeoutMs,
          )
        ).mode;
      } catch (cleanupError) {
        cleanupStatus = {
          status: "failed",
          stop_attempted: true,
          error: messageFromUnknown(cleanupError),
        };
      }
    }
  }

  const consolePath = await artifacts.writeConsole(newConsole);
  const errors = newConsole.filter((entry) => entry.level === "error");
  const warnings = newConsole.filter((entry) => entry.level === "warning");
  const finishedAt = new Date();
  const cleanupFailed = cleanupStatus.status === "failed";
  const status: TestResult["status"] = cleanupFailed || failure ? (failure ? "failed" : "error") : "passed";
  const failureValue = cleanupFailed
    ? {
        code: "CLEANUP_FAILED",
        message: cleanupStatus.error ?? "Playtest cleanup failed",
        step: failureStep,
        assertion: failureAssertion,
      }
    : failure
      ? {
          code: failure instanceof RobloxAxiError ? failure.code : "INTERNAL_ERROR",
          message: messageFromUnknown(failure),
          step: failureStep,
          assertion: failureAssertion,
        }
      : undefined;
  const result: TestResult = {
    schema_version: 1,
    run_id: artifacts.runId,
    test_id: options.spec.id,
    status,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    last_studio_state: lastStudioState,
    assertions: {
      passed: assertionResults.filter((entry) => entry.passed).length,
      failed: assertionResults.filter((entry) => !entry.passed).length,
      results: assertionResults,
    },
    console: {
      errors: errors.length,
      warnings: warnings.length,
      path: consolePath,
      ...(errors.length === 0 && warnings.length === 0
        ? {}
        : {
            excerpt: [...errors, ...warnings]
              .slice(0, 8)
              .map((entry) => `[${entry.level}] ${entry.message}`)
              .join("\n"),
          }),
    },
    cleanup: cleanupStatus,
    evidence: { directory: artifacts.relative(artifacts.directory), screenshots },
    ...(failureValue === undefined ? {} : { failure: failureValue }),
  };
  await artifacts.writeResult(result);

  return {
    result,
    artifactDirectory: artifacts.directory,
    exitCode: cleanupFailed
      ? ExitCode.CleanupFailure
      : failure
        ? exitCodeForFailure(failure)
        : ExitCode.Passed,
  };
}
