import { spawn } from "node:child_process";
import type { ResolvedProjectConfig } from "../types.js";
import { buildRunScriptArguments, type StudioOpenTarget } from "../studio/cli/args.js";
import { discoverMcpLaunch, discoverStudioExecutable } from "../studio/cli/discover.js";
import { StudioService } from "../studio/service.js";
import { SdkMcpTransport } from "../studio/mcp/transport.js";
import { classifySessionCapture, type CapturedSessionTarget, type SessionCapture } from "./classifier.js";
import { luauString } from "./evidence.js";
import type {
  BootstrapArtifacts,
  BootstrapIdentity,
  ManagedSessionRecord,
  SessionObservation,
  SessionOwnershipTuple,
  SessionWorld,
} from "./types.js";
import { WindowsProcessInventory, type WindowsProcessInfo } from "./windows.js";

const PROBE = `
local args = game:GetService([[StudioTestService]]):GetTestArgs()
local players = game:GetService([[Players]])
local runService = game:GetService([[RunService]])
return {
  protocol = type(args) == [[table]] and args.protocol or nil,
  session_id = type(args) == [[table]] and args.session_id or nil,
  project_root = type(args) == [[table]] and args.project_root or nil,
  launch_target = type(args) == [[table]] and args.launch_target or nil,
  requested_clients = type(args) == [[table]] and args.requested_clients or nil,
  players = #players:GetPlayers(),
  is_server = runService:IsServer(),
  is_client = runService:IsClient(),
  loaded = game:IsLoaded(),
  has_local_player = players.LocalPlayer ~= nil,
}
`;

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { value };
    }
  }
  return { value };
}

function contextFromState(raw: unknown, available: string[]): CapturedSessionTarget["context"] {
  const match = /Focused DataModel in the viewport:\s*(Edit|Server|Client)/iu.exec(String(raw));
  if (match?.[1]) return match[1].toLocaleLowerCase() as "edit" | "server" | "client";
  const contexts = available
    .map((item) => item.toLocaleLowerCase())
    .filter((item) => ["edit", "server", "client"].includes(item));
  return contexts.length === 1 ? (contexts[0] as "edit" | "server" | "client") : "unknown";
}

function ownershipFromProbe(value: Record<string, unknown>): Partial<SessionOwnershipTuple> | undefined {
  if (typeof value.session_id !== "string") return undefined;
  return {
    ...(typeof value.protocol === "string" ? { protocol: value.protocol as SessionOwnershipTuple["protocol"] } : {}),
    sessionId: value.session_id,
    ...(typeof value.project_root === "string" ? { projectRoot: value.project_root } : {}),
    ...(typeof value.launch_target === "string" ? { launchTarget: value.launch_target } : {}),
    ...(typeof value.requested_clients === "number" ? { requestedClients: value.requested_clients } : {}),
  };
}

function captureProcesses(processes: WindowsProcessInfo[]) {
  return processes.map((item) => ({
    ...(item.identity === undefined ? {} : { identity: item.identity }),
    parentPid: item.parentPid,
    role: item.role,
  }));
}

function topologySignature(processes: WindowsProcessInfo[]): string {
  return JSON.stringify(
    processes.map((item) => [item.identity?.pid, item.identity?.createdAt, item.parentPid, item.role]).sort(),
  );
}

function targetFor(record: ManagedSessionRecord): StudioOpenTarget {
  return record.project.target.kind === "local"
    ? { kind: "local", localPlaceFile: record.project.target.path }
    : {
        kind: "published",
        placeId: record.project.target.placeId,
        universeId: record.project.target.universeId,
      };
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("spawn", () => resolvePromise(child.pid ?? -1));
  });
}

export class ProductionSessionWorld implements SessionWorld {
  readonly #config: ResolvedProjectConfig | undefined;
  readonly #inventory: WindowsProcessInventory;

  constructor(options: { config?: ResolvedProjectConfig; inventory?: WindowsProcessInventory } = {}) {
    this.#config = options.config;
    this.#inventory = options.inventory ?? new WindowsProcessInventory();
  }

  async observe(record?: ManagedSessionRecord): Promise<SessionObservation> {
    const captureStartedAt = new Date().toISOString();
    const failures: string[] = [];
    const contradictions: string[] = [];
    const before = await this.#inventory.studios().catch((error: unknown) => {
      failures.push(`Windows inventory failed: ${String(error)}`);
      return [];
    });
    let targets: CapturedSessionTarget[] = [];
    let service: StudioService | undefined;
    try {
      const launch = await discoverMcpLaunch({
        ...(this.#config?.studio.mcpCommand === undefined
          ? {}
          : {
              configuredCommand: this.#config.studio.mcpCommand,
              configuredArgs: this.#config.studio.mcpArgs,
            }),
      });
      service = new StudioService(
        new SdkMcpTransport(launch),
        this.#config?.studio.operationTimeoutMs ?? 30_000,
      );
      await service.connect();
      const studios = await service.listStudios();
      targets = await Promise.all(
        studios.map(async (studio): Promise<CapturedSessionTarget> => {
          try {
            const state = await service!.getStudioState(studio.id);
            const context = contextFromState(state.raw, state.availableDataModels);
            if (context !== "server" && context !== "client") return { id: studio.id, context };
            try {
              const probe = asRecord(await service!.executeLuau(studio.id, context, PROBE));
              return {
                id: studio.id,
                context,
                ...(ownershipFromProbe(probe) === undefined ? {} : { ownership: ownershipFromProbe(probe)! }),
                ...(typeof probe.players === "number" ? { joined: probe.players } : {}),
                ...(typeof probe.loaded === "boolean" ? { loaded: probe.loaded } : {}),
                ...(typeof probe.has_local_player === "boolean"
                  ? { hasLocalPlayer: probe.has_local_player }
                  : {}),
              };
            } catch (error) {
              return { id: studio.id, context, error: String(error) };
            }
          } catch (error) {
            return { id: studio.id, context: "unknown", error: String(error) };
          }
        }),
      );
      const revalidated = (await service.listStudios()).map((studio) => studio.id).sort();
      const capturedIds = studios.map((studio) => studio.id).sort();
      if (JSON.stringify(revalidated) !== JSON.stringify(capturedIds)) {
        contradictions.push("MCP target set changed during capture");
      }
    } catch (error) {
      failures.push(`Studio MCP observation failed: ${String(error)}`);
    } finally {
      await service?.close().catch(() => undefined);
    }
    const after = await this.#inventory.studios().catch((error: unknown) => {
      failures.push(`Windows inventory revalidation failed: ${String(error)}`);
      return [];
    });
    const stable = topologySignature(before) === topologySignature(after) && contradictions.length === 0;
    const capture: SessionCapture = {
      captureStartedAt,
      captureFinishedAt: new Date().toISOString(),
      stable,
      processes: captureProcesses(after),
      targets,
      failures,
      contradictions,
    };
    return classifySessionCapture(record, capture);
  }

  async launch(record: ManagedSessionRecord, artifacts: BootstrapArtifacts): Promise<BootstrapIdentity> {
    if (!this.#config) throw new Error("A resolved project configuration is required to launch a session");
    const executable = await discoverStudioExecutable({
      ...(this.#config.studio.executable === undefined
        ? {}
        : { configuredPath: this.#config.studio.executable }),
    });
    const args = buildRunScriptArguments({
      scriptFile: artifacts.scriptPath,
      outputFile: artifacts.logPath,
      quitAfterExecution: true,
      target: targetFor(record),
    });
    const child = spawn(executable, args, {
      cwd: this.#config.root,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    const pid = await waitForSpawn(child);
    child.unref();
    let identity;
    const deadline = Date.now() + 5_000;
    while (identity === undefined && Date.now() < deadline) {
      identity = await this.#inventory.identity(pid);
      if (identity === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    if (!identity) throw new Error(`Unable to confirm bootstrap process identity for PID ${pid}`);
    return {
      ...identity,
      executable,
      scriptPath: artifacts.scriptPath,
      logPath: artifacts.logPath,
    };
  }

  async endOwned(record: ManagedSessionRecord, serverTargetId: string): Promise<void> {
    const launch = await discoverMcpLaunch({
      ...(this.#config?.studio.mcpCommand === undefined
        ? {}
        : {
            configuredCommand: this.#config.studio.mcpCommand,
            configuredArgs: this.#config.studio.mcpArgs,
          }),
    });
    const service = new StudioService(
      new SdkMcpTransport(launch),
      this.#config?.studio.operationTimeoutMs ?? 30_000,
    );
    await service.connect();
    const expected = record.ownership;
    const code = [
      "local service = game:GetService([[StudioTestService]])",
      "local args = service:GetTestArgs()",
      "if type(args) ~= [[table]] then error([[AXI managed-session ownership missing]]) end",
      `if args.protocol ~= ${luauString(expected.protocol)} then error([[AXI managed-session protocol mismatch]]) end`,
      `if args.session_id ~= ${luauString(expected.sessionId)} then error([[AXI managed-session id mismatch]]) end`,
      `if args.project_root ~= ${luauString(expected.projectRoot)} then error([[AXI managed-session project mismatch]]) end`,
      `if args.launch_target ~= ${luauString(expected.launchTarget)} then error([[AXI managed-session target mismatch]]) end`,
      `if args.requested_clients ~= ${expected.requestedClients} then error([[AXI managed-session count mismatch]]) end`,
      `service:EndTest({ protocol = ${luauString(expected.protocol)}, session_id = ${luauString(expected.sessionId)}, outcome = [[stopped]] })`,
      "return true",
    ].join("\n");
    try {
      await service.executeLuau(serverTargetId, "server", code);
    } catch {
      // EndTest may close the MCP target before the call response arrives. The caller must observe teardown.
    } finally {
      await service.close().catch(() => undefined);
    }
  }
}
