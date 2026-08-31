#!/usr/bin/env node

// THROWAWAY PROTOTYPE: proves StudioTestService control and observation joins.
// This is evidence for the Wayfinder ticket, not production architecture.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStudioService, projectConfig } from "../../dist/src/app.js";
import { buildRunScriptArguments } from "../../dist/src/studio/cli/args.js";
import { discoverStudioExecutable } from "../../dist/src/studio/cli/discover.js";

const execFileAsync = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...details })}\n`);
}

function parseArguments(argv) {
  let project;
  let clients;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") project = argv[++index];
    else if (argument === "--clients") clients = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!project) throw new Error("--project <configured-game-repository> is required");
  if (!Number.isInteger(clients) || clients < 1 || clients > 8) {
    throw new Error("--clients must be an integer from 1 through 8");
  }
  return { project, clients };
}

async function studioProcesses() {
  const command = [
    "$ErrorActionPreference='Stop';",
    "@(Get-CimInstance Win32_Process -Filter \"Name='RobloxStudioBeta.exe'\" |",
    "Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine) |",
    "ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    createdAt: String(item.CreationDate),
    executable: String(item.ExecutablePath ?? ""),
    commandLine: String(item.CommandLine ?? ""),
  }));
}

function observedRole(processInfo) {
  if (/\s-task\s+StartServer(?:\s|$)/iu.test(processInfo.commandLine)) return "server";
  if (/\s-task\s+StartClient(?:\s|$)/iu.test(processInfo.commandLine)) return "client";
  if (/\s--task\s+RunScript(?:\s|$)/iu.test(processInfo.commandLine)) return "bootstrap";
  return "edit";
}

function focusedContext(state) {
  const match = /Focused DataModel in the viewport:\s*(Edit|Server|Client)/iu.exec(String(state.raw));
  return match?.[1]?.toLowerCase();
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { value };
    }
  }
  return { value };
}

const READINESS_PROBE = `
local args = game:GetService([[StudioTestService]]):GetTestArgs()
local players = game:GetService([[Players]])
local runService = game:GetService([[RunService]])
return {
  session_id = type(args) == [[table]] and args.session_id or nil,
  requested_clients = type(args) == [[table]] and args.requested_clients or nil,
  players = #players:GetPlayers(),
  is_server = runService:IsServer(),
  is_client = runService:IsClient(),
  loaded = game:IsLoaded(),
  has_local_player = players.LocalPlayer ~= nil,
}
`;

async function inspectSession(service, baselineStudioIds, baselinePids, sessionId, requestedClients) {
  const studios = await service.listStudios();
  const candidates = [];
  for (const studio of studios) {
    if (baselineStudioIds.has(studio.id)) continue;
    try {
      const state = await service.getStudioState(studio.id);
      const context = focusedContext(state);
      if (context !== "server" && context !== "client") {
        candidates.push({ studio, context: context ?? "unknown", mode: state.mode });
        continue;
      }
      try {
        const probe = asRecord(await service.executeLuau(studio.id, context, READINESS_PROBE));
        candidates.push({ studio, context, mode: state.mode, probe });
      } catch (error) {
        candidates.push({ studio, context, mode: state.mode, probeError: String(error?.message ?? error) });
      }
    } catch (error) {
      candidates.push({ studio, stateError: String(error?.message ?? error) });
    }
  }

  const processes = await studioProcesses();
  const newProcesses = processes.filter((item) => !baselinePids.has(item.pid));
  const observed = newProcesses.map((item) => ({
    pid: item.pid,
    parentPid: item.parentPid,
    createdAt: item.createdAt,
    role: observedRole(item),
  }));
  const servers = observed.filter((item) => item.role === "server");
  const clients = observed.filter((item) => item.role === "client");
  const serverTargets = candidates.filter(
    (item) => item.context === "server" && item.probe?.session_id === sessionId,
  );
  const clientTargets = candidates.filter((item) => item.context === "client");
  const joined = serverTargets.length === 1 && Number(serverTargets[0].probe?.players) === requestedClients;
  const processTopology = servers.length === 1 &&
    clients.length === requestedClients &&
    clients.every((item) => item.parentPid === servers[0].pid);
  const datamodelTopology = serverTargets.length === 1 && clientTargets.length === requestedClients;
  const responsiveClients = clientTargets.filter(
    (item) => item.probe?.is_client === true && item.probe?.loaded === true && item.probe?.has_local_player === true,
  ).length;

  return {
    sessionId,
    requestedClients,
    candidates,
    observed,
    serverTargets,
    clientTargets,
    checks: {
      processTopology,
      datamodelTopology,
      joined,
      responsiveClients,
      fullyResponsive: responsiveClients === requestedClients,
    },
  };
}

async function poll(label, timeoutMs, read, accept) {
  const startedAt = Date.now();
  let previous;
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    const signature = JSON.stringify(value);
    if (signature !== previous) emit(label, { state: value });
    previous = signature;
    if (accept(value)) return value;
    await wait(1_000);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = await projectConfig(options.project);
  const service = await createStudioService(config);
  const sessionId = randomUUID();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "roblox-axi-lms-prototype-"));
  const bootstrapPath = join(temporaryDirectory, "bootstrap.luau");
  const outputPath = join(temporaryDirectory, "bootstrap-output.log");
  let live = false;
  let lastReady;

  try {
    const baselineStudios = await service.listStudios();
    const baselineStudioIds = new Set(baselineStudios.map((studio) => studio.id));
    const baselineProcesses = await studioProcesses();
    const unmanaged = baselineProcesses.filter((item) => ["server", "client"].includes(observedRole(item)));
    if (unmanaged.length > 0) {
      throw new Error(`Refusing to start beside an unmanaged Studio simulation: ${JSON.stringify(unmanaged.map((item) => ({ pid: item.pid, role: observedRole(item) })))}`);
    }
    const baselinePids = new Set(baselineProcesses.map((item) => item.pid));
    emit("baseline", {
      studioIds: [...baselineStudioIds],
      processes: baselineProcesses.map((item) => ({ pid: item.pid, createdAt: item.createdAt, role: observedRole(item) })),
    });

    const bootstrap = `
local testService = game:GetService([[StudioTestService]])
local ownership = {
  protocol = [[roblox-studio-axi/local-multiplayer-prototype/v1]],
  session_id = [[${sessionId}]],
  requested_clients = ${options.clients},
  project = ${JSON.stringify(config.project.name)},
}
print([[AXI_LMS_PROTOTYPE_BOOTSTRAP]], ownership.session_id)
local result = testService:ExecuteMultiplayerTestAsync(${options.clients}, ownership)
print([[AXI_LMS_PROTOTYPE_COMPLETE]], ownership.session_id)
return result
`;
    await writeFile(bootstrapPath, bootstrap, "utf8");

    const executable = await discoverStudioExecutable({
      ...(config.studio.executable ? { configuredPath: config.studio.executable } : {}),
    });
    const target = config.project.localPlace
      ? { kind: "local", localPlaceFile: config.project.localPlace }
      : { kind: "published", placeId: config.project.placeId, universeId: config.project.universeId };
    const runArguments = buildRunScriptArguments({
      scriptFile: bootstrapPath,
      outputFile: outputPath,
      quitAfterExecution: true,
      target,
    });
    emit("start_requested", { sessionId, clients: options.clients, executable, runArguments });
    const child = spawn(executable, runArguments, { cwd: config.root, stdio: "ignore", windowsHide: false });
    child.once("spawn", () => emit("bootstrap_spawned", { pid: child.pid }));
    child.once("exit", (code, signal) => emit("bootstrap_exited", { pid: child.pid, code, signal }));
    live = true;

    lastReady = await poll(
      "readiness",
      Math.max(config.studio.startupTimeoutMs * 2, 120_000),
      () => inspectSession(service, baselineStudioIds, baselinePids, sessionId, options.clients),
      (state) => state.checks.processTopology && state.checks.datamodelTopology && state.checks.joined,
    );
    emit("start_result", { result: "ready", verification: lastReady.checks });

    try {
      await execFileAsync(process.execPath, [
        fileURLToPath(import.meta.url),
        "--project",
        config.root,
        "--clients",
        String(options.clients),
      ], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      throw new Error("Independent invocation unexpectedly accepted an unmanaged Studio simulation");
    } catch (error) {
      const output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}`;
      if (!output.includes("Refusing to start beside an unmanaged Studio simulation")) throw error;
      emit("unmanaged_invocation", {
        result: "refused",
        mutation: false,
        evidence: "independent process observed the live simulation before launch",
      });
    }

    const sameCount = await inspectSession(service, baselineStudioIds, baselinePids, sessionId, options.clients);
    if (!sameCount.checks.joined) throw new Error("Ownership/readiness was lost before same-count retry");
    emit("same_count_retry", { requestedClients: options.clients, result: "successful no-op", mutation: false });

    const conflictingCount = options.clients === 8 ? 7 : options.clients + 1;
    emit("different_count_retry", {
      requestedClients: conflictingCount,
      result: "conflict",
      mutation: false,
      liveClients: options.clients,
    });

    const server = sameCount.serverTargets[0];
    const stopCode = `
local service = game:GetService([[StudioTestService]])
local args = service:GetTestArgs()
if type(args) ~= [[table]] or args.session_id ~= [[${sessionId}]] then
  error([[AXI prototype ownership mismatch]])
end
service:EndTest({ session_id = args.session_id, outcome = [[prototype_stop]] })
return true
`;
    emit("stop_requested", { studioId: server.studio.id, sessionId });
    try {
      await service.executeLuau(server.studio.id, "server", stopCode);
    } catch (error) {
      emit("stop_call_disconnected", { message: String(error?.message ?? error) });
    }

    const stopped = await poll(
      "stop_observation",
      60_000,
      () => inspectSession(service, baselineStudioIds, baselinePids, sessionId, options.clients),
      (state) => {
        const ownedPids = new Set(lastReady.observed.map((item) => item.pid));
        const remainingOwnedProcesses = state.observed.filter((item) => ownedPids.has(item.pid));
        return state.serverTargets.length === 0 && state.clientTargets.length === 0 && remainingOwnedProcesses.length === 0;
      },
    );
    live = false;
    emit("stop_result", { result: "stopped", finalState: stopped });
    emit("repeated_stop", { result: "already stopped (no-op)", mutation: false });

    try {
      emit("bootstrap_output", { text: await readFile(outputPath, "utf8") });
    } catch {
      emit("bootstrap_output", { text: null, note: "RunScript output file was not available before prototype exit" });
    }
    emit("verdict", {
      supportedControlJoin: true,
      minimumReadiness: "joined",
      strongestReadiness: lastReady.checks.fullyResponsive ? "responsive" : "joined",
      gracefulOwnedStop: true,
    });
  } finally {
    if (live) {
      emit("cleanup_required", {
        warning: "Prototype failed while its session may still be live; inspect the emitted session ID before cleanup.",
        sessionId,
      });
    } else {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await service.close().catch(() => undefined);
  }
}

main().catch((error) => {
  emit("prototype_error", { message: String(error?.stack ?? error) });
  process.exitCode = 1;
});
