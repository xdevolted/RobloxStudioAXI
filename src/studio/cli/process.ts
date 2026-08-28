import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type { ResolvedProjectConfig } from "../../types.js";
import { ExitCode, RobloxAxiError, messageFromUnknown } from "../../errors.js";
import { withTimeout } from "../../runner/timeout.js";
import { buildOpenArguments, buildRunScriptArguments, type StudioOpenTarget } from "./args.js";
import { discoverStudioExecutable } from "./discover.js";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class StudioCliProcess {
  async targetFromConfig(config: ResolvedProjectConfig): Promise<StudioOpenTarget> {
    if (config.project.localPlace) {
      try {
        await access(config.project.localPlace);
      } catch (error) {
        throw new RobloxAxiError({
          message: `Configured local place does not exist: ${config.project.localPlace}`,
          code: "CONFIG_INVALID",
          exitCode: ExitCode.InvalidInput,
          suggestions: ["Build the configured place before launching Studio"],
          cause: error,
        });
      }
      return { kind: "local", localPlaceFile: config.project.localPlace };
    }
    if (config.project.placeId !== undefined && config.project.universeId !== undefined) {
      return {
        kind: "published",
        placeId: config.project.placeId,
        universeId: config.project.universeId,
      };
    }
    throw new RobloxAxiError({
      message: "Project configuration has no launchable local place or published place identity",
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
      suggestions: [
        "Set project.local_place",
        "Or set both project.place_id and project.universe_id",
      ],
    });
  }

  async launchProject(config: ResolvedProjectConfig): Promise<{ executable: string; args: string[]; pid: number }> {
    const executable = await discoverStudioExecutable({
      ...(config.studio.executable === undefined ? {} : { configuredPath: config.studio.executable }),
    });
    const args = buildOpenArguments(await this.targetFromConfig(config));
    const child = spawn(executable, args, { cwd: config.root, detached: true, stdio: "ignore" });
    const pid = await waitForSpawn(child);
    child.unref();
    return { executable, args, pid };
  }

  async runScript(options: {
    config: ResolvedProjectConfig;
    scriptFile: string;
    outputFile?: string;
    quitAfterExecution?: boolean;
    timeoutMs?: number;
  }): Promise<ProcessResult> {
    const executable = await discoverStudioExecutable({
      ...(options.config.studio.executable === undefined
        ? {}
        : { configuredPath: options.config.studio.executable }),
    });
    const args = buildRunScriptArguments({
      scriptFile: options.scriptFile,
      ...(options.outputFile === undefined ? {} : { outputFile: options.outputFile }),
      quitAfterExecution: options.quitAfterExecution ?? false,
      target: await this.targetFromConfig(options.config),
    });
    return withTimeout(
      "Roblox Studio RunScript",
      options.timeoutMs ?? options.config.studio.startupTimeoutMs,
      () => collectProcess(executable, args, options.config.root),
    );
  }
}

function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      rejectPromise(
        new RobloxAxiError({
          message: `Failed to launch Roblox Studio: ${messageFromUnknown(error)}`,
          code: "STUDIO_UNAVAILABLE",
          exitCode: ExitCode.StudioUnavailable,
          cause: error,
        }),
      );
    });
    child.once("spawn", () => resolvePromise(child.pid ?? -1));
  });
}

function collectProcess(executable: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectPromise);
    child.once("close", (code) =>
      resolvePromise({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}
