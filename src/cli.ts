import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { booleanFlag, parseArguments, stringFlag, type ParsedArguments } from "./cli-args.js";
import {
  connectAndSelect,
  createStudioService,
  internalize,
  projectConfig,
  statusView,
  truncate,
} from "./app.js";
import { messageFromUnknown, usageError } from "./errors.js";
import { jsonOutput, compactRunResult } from "./output.js";
import { loadPlaytestSpec, loadWorkflowSpec } from "./project/load-spec.js";
import { assertSafeTestEnvironment } from "./project/load-config.js";
import { validateSchema } from "./project/schema.js";
import { validateSpecSemantics, runPlaytest } from "./runner/test-runner.js";
import { resolveWorkflowTests, runWorkflow } from "./runner/workflow-runner.js";
import { discoverStudioExecutable } from "./studio/cli/discover.js";
import type { ResolvedProjectConfig, TestResult } from "./types.js";
import { VERSION } from "./version.js";
import { createProductionManagedSession } from "./session/factory.js";
import { resolveSessionProjectIdentity } from "./session/identity.js";
import type { SessionResponse } from "./session/types.js";
import { createGuardedPlayControl } from "./studio/play-control.js";

const DESCRIPTION = "Launch, inspect, and deterministically playtest configured Roblox Studio projects";
type AxiRenderable = string | Record<string, unknown>;

const TOP_LEVEL_HELP = `roblox-studio-axi - ${DESCRIPTION}

Usage: roblox-studio-axi <command> [args] [flags]

Commands:
  status                         Show project and live Studio state
  studios list                   List connected Studio instances
  project inspect                Inspect resolved project configuration
  test validate <spec>           Validate a playtest specification
  test run <spec>                Run a playtest with evidence and guaranteed cleanup
  test explain <result|run-id>   Explain a saved result
  workflow list                  List project workflows
  workflow run <name>            Run a workflow
  session start --clients <n>    Start or re-observe a managed Local Multiplayer Session
  session status                 Inspect the user-global managed session
  session stop                   Stop the exactly owned managed session
  stop                           Stop play mode safely
  version                        Print the AXI version

Global flags (after the command):
  --project <path>  Override project discovery
  --studio <id>     Select a connected Studio explicitly
  --json            Emit JSON
  --full            Include expanded detail
  --verbose         Write diagnostics to stderr

Examples:
  roblox-studio-axi status
  roblox-studio-axi test run tests/playtests/baseline/smoke.yaml --json
  roblox-studio-axi studios list --project C:\\Games\\MyGame
`;

const HELP = {
  status: `Usage: roblox-studio-axi status [--project <path>] [--json] [--full]\nShows configured project state and a compact live Studio/MCP summary.\n`,
  studios: `Usage: roblox-studio-axi studios list [--project <path>] [--json] [--full]\nLists every connected Studio with its explicit studio ID.\n`,
  project: `Usage: roblox-studio-axi project inspect [--project <path>] [--json] [--full]\nShows resolved, non-secret project configuration and launch readiness.\n`,
  test: `Usage:\n  roblox-studio-axi test validate <spec> [--project <path>] [--json]\n  roblox-studio-axi test run <spec> [--project <path>] [--studio <id>] [--json] [--full] [--verbose]\n  roblox-studio-axi test explain <result|run-id> [--project <path>] [--json] [--full]\n`,
  workflow: `Usage:\n  roblox-studio-axi workflow list [--project <path>] [--json] [--full]\n  roblox-studio-axi workflow run <name|path> [--project <path>] [--studio <id>] [--json] [--full] [--verbose]\n`,
  session: `Usage:\n  roblox-studio-axi session start --clients <1..8> [--project <path>] [--timeout <seconds>] [--json] [--full] [--verbose]\n  roblox-studio-axi session status [--project <path>] [--timeout <seconds>] [--json] [--full] [--verbose]\n  roblox-studio-axi session stop [--project <path>] [--timeout <seconds>] [--json] [--full] [--verbose]\n`,
  stop: `Usage: roblox-studio-axi stop [--project <path>] [--studio <id>] [--json]\nStops play mode. Already stopped is a successful no-op.\n`,
  version: `Usage: roblox-studio-axi version [--json]\nPrints the installed AXI version. -v, -V, and --version are fast-path aliases.\n`,
} as const;

function wantsHelp(args: string[]): boolean {
  return args.includes("--help");
}

function format(value: unknown, parsed: ParsedArguments): AxiRenderable {
  return booleanFlag(parsed, "--json") ? jsonOutput(value) : (value as AxiRenderable);
}

function configFrom(parsed: ParsedArguments): Promise<ResolvedProjectConfig> {
  return projectConfig(stringFlag(parsed, "--project"));
}

function commonParse(options: {
  args: string[];
  command: string;
  usage: string;
  min?: number;
  max?: number;
}): ParsedArguments {
  return parseArguments({
    args: options.args,
    command: options.command,
    usage: options.usage,
    minPositionals: options.min ?? 0,
    maxPositionals: options.max ?? 0,
  });
}

async function statusCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.status;
  const parsed = commonParse({ args, command: "status", usage: "roblox-studio-axi status" });
  const config = await configFrom(parsed);
  return format(
    await statusView(
      config,
      booleanFlag(parsed, "--full"),
      stringFlag(parsed, "--studio"),
    ),
    parsed,
  );
}

async function studiosCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.studios;
  const subcommand = args[0];
  if (subcommand !== "list") {
    throw usageError(`Unknown studios command: ${subcommand ?? "(missing)"}`, [HELP.studios.trim()]);
  }
  const parsed = commonParse({
    args: args.slice(1),
    command: "studios list",
    usage: "roblox-studio-axi studios list",
  });
  const config = await configFrom(parsed);
  const service = await createStudioService(config);
  try {
    const studios = await service.listStudios();
    const output =
      studios.length === 0
        ? { count: 0, studios: "0 connected Studio instances found" }
        : {
            count: studios.length,
            studios: studios.map((studio) => ({
              id: studio.id,
              name: studio.name,
              ...(studio.placeId === undefined ? {} : { place_id: studio.placeId }),
            })),
            help: ["Run `roblox-studio-axi status --studio <id>`"],
          };
    return format(output, parsed);
  } finally {
    await service.close();
  }
}

async function projectCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.project;
  if (args[0] !== "inspect") {
    throw usageError(`Unknown project command: ${args[0] ?? "(missing)"}`, [HELP.project.trim()]);
  }
  const parsed = commonParse({
    args: args.slice(1),
    command: "project inspect",
    usage: "roblox-studio-axi project inspect",
  });
  const config = await configFrom(parsed);
  let executable: string | undefined;
  let executableError: string | undefined;
  try {
    executable = await discoverStudioExecutable({
      ...(config.studio.executable === undefined ? {} : { configuredPath: config.studio.executable }),
    });
  } catch (error) {
    executableError = messageFromUnknown(error);
  }
  const output = {
    project: config.project.name,
    root: config.root,
    config: config.configPath,
    place: {
      ...(config.project.localPlace === undefined ? {} : { local_file: config.project.localPlace }),
      ...(config.project.placeId === undefined ? {} : { place_id: config.project.placeId }),
      ...(config.project.universeId === undefined ? {} : { universe_id: config.project.universeId }),
      ...(config.project.expectedPlaceName === undefined
        ? {}
        : { expected_name: config.project.expectedPlaceName }),
    },
    studio: {
      executable: executable ?? "not found",
      ...(executableError === undefined ? {} : { error: truncate(executableError) }),
      startup_timeout_seconds: config.studio.startupTimeoutMs / 1_000,
      operation_timeout_seconds: config.studio.operationTimeoutMs / 1_000,
    },
    testing: {
      playtests: config.testing.playtestsDirectory,
      workflows: config.testing.workflowsDirectory,
      ...(config.testing.defaultWorkflow === undefined
        ? {}
        : { default_workflow: config.testing.defaultWorkflow }),
    },
    evidence: config.evidence,
    safety: config.safety,
  };
  return format(output, parsed);
}

function installInterruptSignal() {
  const controller = new AbortController();
  const handler = () => {
    controller.abort();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    },
  };
}

async function testCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.test;
  const subcommand = args[0];
  if (!subcommand || !["validate", "run", "explain"].includes(subcommand)) {
    throw usageError(`Unknown test command: ${subcommand ?? "(missing)"}`, [HELP.test.trim()]);
  }
  const parsed = commonParse({
    args: args.slice(1),
    command: `test ${subcommand}`,
    usage: `roblox-studio-axi test ${subcommand} <value>`,
    min: 1,
    max: 1,
  });
  const config = await configFrom(parsed);
  const value = parsed.positionals[0]!;

  if (subcommand === "validate") {
    const loaded = await loadPlaytestSpec(config, value);
    validateSpecSemantics(loaded.spec);
    return format(
      {
        valid: true,
        spec: loaded.spec.id,
        path: relative(config.root, loaded.path).replaceAll("\\", "/"),
        steps: loaded.spec.steps.length,
        assertions: loaded.spec.assertions?.length ?? 0,
      },
      parsed,
    );
  }

  if (subcommand === "explain") {
    const resultPath = await resolveResultPath(config, value);
    const result = await validateSchema<TestResult>(
      "result",
      JSON.parse(await readFile(resultPath, "utf8")),
    );
    if (booleanFlag(parsed, "--json")) return jsonOutput(result);
    if (booleanFlag(parsed, "--full")) {
      const consolePath = resolve(config.root, result.console.path);
      const consoleText = await readFile(consolePath, "utf8").catch(() => "");
      return { result, console: consoleText || "0 relevant console entries" };
    }
    return compactRunResult(result);
  }

  const loaded = await loadPlaytestSpec(config, value);
  validateSpecSemantics(loaded.spec);
  assertSafeTestEnvironment(config);
  const connected = await connectAndSelect({
    config,
    ...(stringFlag(parsed, "--studio") === undefined
      ? {}
      : { explicitStudioId: stringFlag(parsed, "--studio")! }),
    launchIfMissing: true,
    verbose: booleanFlag(parsed, "--verbose"),
  });
  const interrupt = installInterruptSignal();
  try {
    const outcome = await runPlaytest({
      config,
      spec: loaded.spec,
      source: loaded.source,
      service: connected.service,
      playControl: createGuardedPlayControl({ service: connected.service, config }),
      studio: connected.studio,
      signal: interrupt.signal,
    });
    process.exitCode = outcome.exitCode;
    if (booleanFlag(parsed, "--json")) return jsonOutput(outcome.result);
    return booleanFlag(parsed, "--full")
      ? (outcome.result as unknown as Record<string, unknown>)
      : compactRunResult(outcome.result);
  } finally {
    interrupt.dispose();
    await connected.service.close();
  }
}

async function resolveResultPath(config: ResolvedProjectConfig, value: string): Promise<string> {
  const direct = isAbsolute(value) ? value : resolve(config.root, value);
  try {
    const info = await stat(direct);
    if (info.isFile()) return direct;
    if (info.isDirectory()) return join(direct, "result.json");
  } catch {
    // Fall through to interpreting the value as a run ID.
  }
  return join(config.evidence.directory, value, "result.json");
}

async function workflowCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.workflow;
  const subcommand = args[0];
  if (!subcommand || !["list", "run"].includes(subcommand)) {
    throw usageError(`Unknown workflow command: ${subcommand ?? "(missing)"}`, [HELP.workflow.trim()]);
  }
  const parsed = commonParse({
    args: args.slice(1),
    command: `workflow ${subcommand}`,
    usage: `roblox-studio-axi workflow ${subcommand}${subcommand === "run" ? " <name>" : ""}`,
    min: subcommand === "run" ? 1 : 0,
    max: subcommand === "run" ? 1 : 0,
  });
  const config = await configFrom(parsed);
  if (subcommand === "list") {
    const paths = await fg(["**/*.yaml", "**/*.yml"], {
      cwd: config.testing.workflowsDirectory,
      absolute: true,
      onlyFiles: true,
    });
    paths.sort();
    if (paths.length === 0) {
      return format({ count: 0, workflows: "0 workflows found in this project" }, parsed);
    }
    const workflows = await Promise.all(
      paths.map(async (path) => {
        const loaded = await loadWorkflowSpec(config, path);
        const tests = await resolveWorkflowTests(config, loaded.workflow).catch(() => []);
        return {
          name: loaded.workflow.name,
          tests: tests.length,
          file: relative(config.root, path).replaceAll("\\", "/"),
          ...(booleanFlag(parsed, "--full") ? { include: loaded.workflow.tests.include } : {}),
        };
      }),
    );
    return format({ count: workflows.length, workflows }, parsed);
  }

  const loaded = await loadWorkflowSpec(config, parsed.positionals[0]!);
  assertSafeTestEnvironment(config);
  const connected = await connectAndSelect({
    config,
    ...(stringFlag(parsed, "--studio") === undefined
      ? {}
      : { explicitStudioId: stringFlag(parsed, "--studio")! }),
    launchIfMissing: true,
    verbose: booleanFlag(parsed, "--verbose"),
  });
  const interrupt = installInterruptSignal();
  try {
    const outcome = await runWorkflow({
      config,
      workflow: loaded.workflow,
      service: connected.service,
      playControl: createGuardedPlayControl({ service: connected.service, config }),
      studio: connected.studio,
      signal: interrupt.signal,
    });
    process.exitCode = outcome.exitCode;
    const output = {
      workflow: outcome.name,
      status: outcome.status,
      tests: `${outcome.tests.filter((test) => test.status === "passed").length} passed, ${outcome.tests.filter((test) => test.status !== "passed").length} failed`,
      results: outcome.tests.map((test) => compactRunResult(test)),
    };
    return format(booleanFlag(parsed, "--full") ? { ...output, full_results: outcome.tests } : output, parsed);
  } finally {
    interrupt.dispose();
    await connected.service.close();
  }
}

async function stopCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.stop;
  const parsed = commonParse({ args, command: "stop", usage: "roblox-studio-axi stop" });
  const config = await configFrom(parsed);
  const connected = await connectAndSelect({
    config,
    ...(stringFlag(parsed, "--studio") === undefined
      ? {}
      : { explicitStudioId: stringFlag(parsed, "--studio")! }),
  });
  try {
    const changed = await createGuardedPlayControl({
      service: connected.service,
      config,
    }).stop(connected.studio.id);
    const output = {
      studio: connected.studio.id,
      state: "edit",
      changed,
      result: changed ? "playtest stopped" : "already stopped (no-op)",
    };
    return format(output, parsed);
  } finally {
    await connected.service.close();
  }
}

function sessionTimeout(parsed: ParsedArguments, fallbackSeconds: number): number {
  const raw = stringFlag(parsed, "--timeout");
  if (raw === undefined) return fallbackSeconds * 1_000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw usageError("--timeout must be a positive number of seconds", [HELP.session.trim()]);
  }
  return seconds * 1_000;
}

function sessionOutput(response: SessionResponse, parsed: ParsedArguments): AxiRenderable {
  const presented = structuredClone(response);
  if (!booleanFlag(parsed, "--full")) {
    delete presented.actions;
    delete presented.details;
  }
  return format(presented as unknown as Record<string, unknown>, parsed);
}

async function sessionCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.session;
  const subcommand = args[0];
  if (!subcommand || !["start", "status", "stop"].includes(subcommand)) {
    throw usageError(`Unknown session command: ${subcommand ?? "(missing)"}`, [HELP.session.trim()]);
  }
  const parsed = parseArguments({
    args: args.slice(1),
    command: `session ${subcommand}`,
    usage: `roblox-studio-axi session ${subcommand}`,
    minPositionals: 0,
    maxPositionals: 0,
    globalFlags: ["--json", "--full", "--verbose", "--project"],
    flags: {
      "--timeout": "value",
      ...(subcommand === "start" ? { "--clients": "value" as const } : {}),
    },
  });
  const interrupt = installInterruptSignal();
  try {
    if (subcommand === "start") {
      const clientsRaw = stringFlag(parsed, "--clients");
      const clients = clientsRaw === undefined ? Number.NaN : Number(clientsRaw);
      if (!Number.isInteger(clients) || clients < 1 || clients > 8) {
        throw usageError("--clients is required and must be an integer from 1 through 8", [
          HELP.session.trim(),
        ]);
      }
      const timeoutMs = sessionTimeout(parsed, 120);
      const config = await configFrom(parsed);
      assertSafeTestEnvironment(config);
      const managed = createProductionManagedSession({ config });
      const outcome = await managed.start(
        { project: await resolveSessionProjectIdentity(config), clients },
        { timeoutMs, signal: interrupt.signal, full: booleanFlag(parsed, "--full") },
      );
      process.exitCode = outcome.exitCode;
      return sessionOutput(outcome.response, parsed);
    }

    const timeoutMs = sessionTimeout(parsed, subcommand === "status" ? 30 : 60);
    const explicitProject = stringFlag(parsed, "--project");
    const config = explicitProject === undefined ? undefined : await configFrom(parsed);
    const project = config === undefined ? undefined : await resolveSessionProjectIdentity(config);
    const managed = createProductionManagedSession({ ...(config === undefined ? {} : { config }) });
    const context = {
      timeoutMs,
      signal: interrupt.signal,
      full: booleanFlag(parsed, "--full"),
    };
    const outcome = subcommand === "status"
      ? await managed.status(project === undefined ? {} : { project }, context)
      : await managed.stop(project === undefined ? {} : { project }, context);
    process.exitCode = outcome.exitCode;
    return sessionOutput(outcome.response, parsed);
  } finally {
    interrupt.dispose();
  }
}

async function versionCommand(args: string[]): Promise<AxiRenderable> {
  if (wantsHelp(args)) return HELP.version;
  const parsed = commonParse({ args, command: "version", usage: "roblox-studio-axi version" });
  return booleanFlag(parsed, "--json") ? jsonOutput({ version: VERSION }) : VERSION;
}

function errorFormatter(error: unknown, argv: string[]) {
  const normalized = internalize(error, "Command");
  if (argv.includes("--verbose") && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  const output = {
    error: normalized.message,
    code: normalized.code,
    ...(normalized.details === undefined || !argv.includes("--full")
      ? {}
      : { details: normalized.details }),
    ...(normalized.suggestions.length === 0 ? {} : { help: normalized.suggestions }),
  };
  return {
    output: `${argv.includes("--json") ? jsonOutput(output) : encode(output)}\n`,
    exitCode: normalized.exitCode,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: "roblox-studio-axi",
    argv,
    topLevelHelp: TOP_LEVEL_HELP,
    commands: {
      status: statusCommand,
      studios: studiosCommand,
      project: projectCommand,
      test: testCommand,
      workflow: workflowCommand,
      session: sessionCommand,
      stop: stopCommand,
      version: versionCommand,
      update: async () => {
        throw usageError("Self-update is unavailable for this local development package", [
          "Update or relink SharedLibraries/RobloxStudioAXI from its source checkout",
        ]);
      },
    },
    home: async () => {
      try {
        return await statusView(await projectConfig(), false);
      } catch (error) {
        throw internalize(error, "Home view");
      }
    },
    formatError: (error) => errorFormatter(error, argv),
    renderUnknownCommand: (command) =>
      `${encode({
        error: `Unknown command: ${command}`,
        code: "USAGE_ERROR",
        help: ["Run `roblox-studio-axi --help`"],
      })}\n`,
  });
}
