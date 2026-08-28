import fg from "fast-glob";
import { relative } from "node:path";
import { ExitCode, RobloxAxiError, messageFromUnknown } from "./errors.js";
import { loadProjectConfig } from "./project/load-config.js";
import { discoverMcpLaunch } from "./studio/cli/discover.js";
import { StudioCliProcess } from "./studio/cli/process.js";
import { SdkMcpTransport } from "./studio/mcp/transport.js";
import { selectStudio } from "./studio/selection.js";
import { StudioService } from "./studio/service.js";
import type { ResolvedProjectConfig, StudioInstance } from "./types.js";
import { pollUntil } from "./runner/timeout.js";
import { AGENT_GUIDANCE } from "./guidance.js";

export interface ConnectedStudio {
  service: StudioService;
  studio: StudioInstance;
  launched?: { executable: string; args: string[]; pid: number };
}

export async function projectConfig(explicitProject?: string): Promise<ResolvedProjectConfig> {
  return loadProjectConfig({
    ...(explicitProject === undefined ? {} : { explicitProject }),
  });
}

export async function createStudioService(config: ResolvedProjectConfig): Promise<StudioService> {
  const launch = await discoverMcpLaunch({
    ...(config.studio.mcpCommand === undefined
      ? {}
      : { configuredCommand: config.studio.mcpCommand, configuredArgs: config.studio.mcpArgs }),
  });
  const service = new StudioService(
    new SdkMcpTransport(launch),
    config.studio.operationTimeoutMs,
  );
  await service.connect();
  return service;
}

export async function connectAndSelect(options: {
  config: ResolvedProjectConfig;
  explicitStudioId?: string;
  launchIfMissing?: boolean;
  verbose?: boolean;
}): Promise<ConnectedStudio> {
  const service = await createStudioService(options.config);
  try {
    let studios = await service.listStudios();
    let launched: ConnectedStudio["launched"];
    if (studios.length === 0 && options.launchIfMissing) {
      launched = await new StudioCliProcess().launchProject(options.config);
      if (options.verbose) {
        process.stderr.write(`Launched Studio process ${launched.pid}\n`);
      }
      studios = await pollUntil({
        operation: "Studio MCP instance discovery",
        timeoutMs: options.config.studio.startupTimeoutMs,
        intervalMs: 500,
        read: () => service.listStudios(),
        accept: (items) => items.length > 0,
      });
    }
    const studio = selectStudio({
      studios,
      config: options.config,
      ...(options.explicitStudioId === undefined
        ? {}
        : { explicitStudioId: options.explicitStudioId }),
    });
    return { service, studio, ...(launched === undefined ? {} : { launched }) };
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}

export async function countProjectFiles(config: ResolvedProjectConfig): Promise<{
  playtests: number;
  workflows: number;
}> {
  const [playtests, workflows] = await Promise.all([
    fg(["**/*.yaml", "**/*.yml"], { cwd: config.testing.playtestsDirectory, onlyFiles: true }),
    fg(["**/*.yaml", "**/*.yml"], { cwd: config.testing.workflowsDirectory, onlyFiles: true }),
  ]);
  return { playtests: playtests.length, workflows: workflows.length };
}

export async function statusView(
  config: ResolvedProjectConfig,
  full = false,
  explicitStudioId?: string,
): Promise<Record<string, unknown>> {
  const counts = await countProjectFiles(config);
  const base: Record<string, unknown> = {
    axi: "0.1.0",
    project: config.project.name,
    config: relative(config.root, config.configPath).replaceAll("\\", "/"),
    tests: counts.playtests,
    workflows: counts.workflows,
  };
  let service: StudioService | undefined;
  try {
    service = await createStudioService(config);
    const studios = await service.listStudios();
    base.studio_count = studios.length;
    if (studios.length === 0) {
      base.studio = "disconnected";
    } else {
      try {
        const selected = selectStudio({
          studios,
          config,
          ...(explicitStudioId === undefined ? {} : { explicitStudioId }),
        });
        const state = await service.getStudioState(selected.id);
        base.studio = "connected";
        base.selected_studio = selected.name;
        base.studio_id = selected.id;
        base.play_state = state.mode;
      } catch (error) {
        if (error instanceof RobloxAxiError && error.code === "STUDIO_AMBIGUOUS") {
          base.studio = "ambiguous";
          base.studios = error.details;
        } else {
          throw error;
        }
      }
    }
    if (full) base.mcp_tools = service.capabilities.available;
  } catch (error) {
    if (
      explicitStudioId !== undefined &&
      error instanceof RobloxAxiError &&
      (error.code === "STUDIO_UNAVAILABLE" || error.code === "STUDIO_AMBIGUOUS")
    ) {
      throw error;
    }
    base.studio = "disconnected";
    base.studio_count = 0;
    base.mcp = "unavailable";
    base.mcp_error = full ? messageFromUnknown(error) : truncate(messageFromUnknown(error), 500);
    if (error instanceof RobloxAxiError) base.mcp_error_code = error.code;
    if (full && error instanceof RobloxAxiError && error.details !== undefined) {
      base.mcp_diagnostic = error.details;
    }
  } finally {
    await service?.close().catch(() => undefined);
  }
  base.help = [AGENT_GUIDANCE.rules[0], "Run `roblox-studio-axi studios list`"];
  return base;
}

export function truncate(value: string, maximum = 1_000): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}... (truncated, ${value.length} chars total)`;
}

export function internalize(error: unknown, operation: string): RobloxAxiError {
  if (error instanceof RobloxAxiError) return error;
  return new RobloxAxiError({
    message: `${operation} failed: ${messageFromUnknown(error)}`,
    code: "INTERNAL_ERROR",
    exitCode: ExitCode.Internal,
    cause: error,
  });
}
