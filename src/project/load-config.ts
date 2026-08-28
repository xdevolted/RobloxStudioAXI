import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ExitCode, RobloxAxiError } from "../errors.js";
import type { ProjectConfigFile, ResolvedProjectConfig } from "../types.js";
import { discoverProjectRoot } from "./discover.js";
import { validateSchema } from "./schema.js";

function mergeRecord(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const prior = merged[key];
    if (
      prior &&
      value &&
      typeof prior === "object" &&
      typeof value === "object" &&
      !Array.isArray(prior) &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeRecord(prior as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function loadOptionalToml(path: string): Promise<Record<string, unknown>> {
  try {
    return parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function globalConfigPaths(): string[] {
  if (process.platform === "win32" && process.env.APPDATA) {
    return [resolve(process.env.APPDATA, "roblox-studio-axi", "config.toml")];
  }
  return [resolve(homedir(), ".config", "roblox-studio-axi", "config.toml")];
}

function resolveProjectPath(root: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

export async function loadProjectConfig(options: {
  startDirectory?: string;
  explicitProject?: string;
} = {}): Promise<ResolvedProjectConfig> {
  const discovered = await discoverProjectRoot(options);
  let globalValue: Record<string, unknown> = {};
  for (const path of globalConfigPaths()) {
    globalValue = mergeRecord(globalValue, await loadOptionalToml(path));
  }
  const projectValue = parseToml(await readFile(discovered.configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const raw = await validateSchema<ProjectConfigFile>(
    "project-config",
    mergeRecord(globalValue, projectValue),
  );
  if ((raw.project.place_id === undefined) !== (raw.project.universe_id === undefined)) {
    throw new RobloxAxiError({
      message: "project.place_id and project.universe_id must be configured together",
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
    });
  }
  if (raw.project.local_place && !/\.rbxlx?$/iu.test(raw.project.local_place)) {
    throw new RobloxAxiError({
      message: "project.local_place must reference a .rbxl or .rbxlx file",
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
    });
  }

  const project: ResolvedProjectConfig["project"] = { name: raw.project.name };
  if (raw.project.place_id !== undefined) project.placeId = raw.project.place_id;
  if (raw.project.universe_id !== undefined) project.universeId = raw.project.universe_id;
  if (raw.project.expected_place_name !== undefined) {
    project.expectedPlaceName = raw.project.expected_place_name;
  }
  const localPlace = resolveProjectPath(discovered.root, raw.project.local_place);
  if (localPlace !== undefined) project.localPlace = localPlace;

  const studio: ResolvedProjectConfig["studio"] = {
    mcpArgs: raw.studio?.mcp_args ?? [],
    startupTimeoutMs: (raw.studio?.startup_timeout_seconds ?? 60) * 1_000,
    operationTimeoutMs: (raw.studio?.operation_timeout_seconds ?? 30) * 1_000,
  };
  const executable = resolveProjectPath(discovered.root, raw.studio?.executable);
  if (executable !== undefined) studio.executable = executable;
  if (raw.studio?.mcp_command !== undefined) studio.mcpCommand = raw.studio.mcp_command;

  const testing: ResolvedProjectConfig["testing"] = {
    playtestsDirectory: resolve(discovered.root, raw.testing?.playtests ?? "tests/playtests"),
    workflowsDirectory: resolve(discovered.root, raw.testing?.workflows ?? ".axi/workflows"),
  };
  if (raw.testing?.default_workflow !== undefined) {
    testing.defaultWorkflow = raw.testing.default_workflow;
  }

  return {
    schemaVersion: 1,
    root: discovered.root,
    configPath: discovered.configPath,
    project,
    studio,
    testing,
    evidence: {
      directory: resolve(discovered.root, raw.evidence?.directory ?? ".artifacts/playtests"),
      screenshots: raw.evidence?.screenshots ?? "on_failure",
      console: raw.evidence?.console ?? "errors_and_warnings",
    },
    safety: {
      environment: raw.safety?.environment ?? "test",
      allowPublish: false,
      allowLiveDatastores: raw.safety?.allow_live_datastores ?? false,
      alwaysStopPlaytest: true,
    },
  };
}

export function assertSafeTestEnvironment(config: ResolvedProjectConfig): void {
  if (config.safety.environment === "production" || config.safety.allowLiveDatastores) {
    throw new RobloxAxiError({
      message: "Playtests are forbidden for production or live-datastore configurations",
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
      suggestions: [
        "Use a test or development environment",
        "Set safety.allow_live_datastores = false",
      ],
    });
  }
}
