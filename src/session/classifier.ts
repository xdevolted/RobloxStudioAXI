import type {
  ManagedSessionRecord,
  ProcessIdentity,
  SessionObservation,
  SessionOwnershipTuple,
  SessionReadiness,
} from "./types.js";

export interface CapturedSessionProcess {
  identity?: ProcessIdentity;
  parentPid: number;
  role: "edit" | "bootstrap" | "server" | "client";
}

export interface CapturedSessionTarget {
  id: string;
  context: "edit" | "server" | "client" | "unknown";
  ownership?: Partial<SessionOwnershipTuple>;
  joined?: number;
  loaded?: boolean;
  hasLocalPlayer?: boolean;
  error?: string;
}

export interface SessionCapture {
  captureStartedAt: string;
  captureFinishedAt: string;
  stable: boolean;
  processes: CapturedSessionProcess[];
  targets: CapturedSessionTarget[];
  failures: string[];
  contradictions: string[];
}

function sameProcess(left: ProcessIdentity | undefined, right: ProcessIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.pid === right.pid && left.createdAt === right.createdAt;
}

function sameOwnership(
  actual: Partial<SessionOwnershipTuple> | undefined,
  expected: SessionOwnershipTuple,
): boolean {
  return (
    actual?.protocol === expected.protocol &&
    actual.sessionId === expected.sessionId &&
    actual.projectRoot === expected.projectRoot &&
    actual.launchTarget === expected.launchTarget &&
    actual.requestedClients === expected.requestedClients
  );
}

function readinessRank(value: SessionReadiness): number {
  return [
    "none",
    "bootstrap",
    "process_topology",
    "datamodel_topology",
    "server_responsive",
    "joined",
    "responsive",
  ].indexOf(value);
}

function strongest(current: SessionReadiness, candidate: SessionReadiness, achieved: boolean): SessionReadiness {
  return achieved && readinessRank(candidate) > readinessRank(current) ? candidate : current;
}

export function classifySessionCapture(
  record: ManagedSessionRecord | undefined,
  capture: SessionCapture,
): SessionObservation {
  const servers = capture.processes.filter((item) => item.role === "server");
  const clients = capture.processes.filter((item) => item.role === "client");
  const serverTargets = capture.targets.filter((item) => item.context === "server");
  const clientTargets = capture.targets.filter((item) => item.context === "client");
  const possibleSimulation =
    servers.length > 0 || clients.length > 0 || serverTargets.length > 0 || clientTargets.length > 1;
  const contradictions = [...capture.contradictions];
  if (capture.failures.length > 0) contradictions.push(...capture.failures.map((item) => `adapter: ${item}`));
  const missingProcessIdentity = capture.processes.some(
    (item) => item.role !== "edit" && item.identity === undefined,
  );
  if (missingProcessIdentity) contradictions.push("candidate process lacks PID/creation identity");

  if (record === undefined) {
    return {
      capturedAt: capture.captureFinishedAt,
      stable: capture.stable,
      possibleSimulation,
      ownership: possibleSimulation ? "unmanaged" : "none",
      readiness: "none",
      health: possibleSimulation ? "indeterminate" : "not_applicable",
      clients: {
        ...(capture.processes.length === 0 ? {} : { processes: clients.length }),
        ...(capture.targets.length === 0 ? {} : { datamodels: clientTargets.length }),
      },
      contradictions,
    };
  }

  const ownedServers = serverTargets.filter((target) => sameOwnership(target.ownership, record.ownership));
  const wrongOwnedTargets = capture.targets.filter(
    (target) => target.ownership?.sessionId !== undefined && !sameOwnership(target.ownership, record.ownership),
  );
  const ownership = !capture.stable || missingProcessIdentity || ownedServers.length > 1 || wrongOwnedTargets.length > 0
    ? "ambiguous"
    : ownedServers.length === 1
      ? "proved"
      : "recorded";
  const bootstrapObserved = capture.processes.some((item) => sameProcess(item.identity, record.bootstrap));
  const processTopology =
    servers.length === 1 &&
    clients.length === record.clients &&
    servers[0]?.identity !== undefined &&
    clients.every((item) => item.parentPid === servers[0]!.identity!.pid);
  const datamodelTopology = serverTargets.length === 1 && clientTargets.length === record.clients;
  const server = ownedServers[0];
  const joined = ownership === "proved" && processTopology && datamodelTopology && server?.joined === record.clients;
  const responsiveClients = clientTargets.filter(
    (target) =>
      sameOwnership(target.ownership, record.ownership) &&
      target.loaded === true &&
      target.hasLocalPlayer === true,
  ).length;

  let readiness: SessionReadiness = "none";
  readiness = strongest(readiness, "bootstrap", bootstrapObserved);
  readiness = strongest(readiness, "process_topology", processTopology);
  readiness = strongest(readiness, "datamodel_topology", processTopology && datamodelTopology);
  readiness = strongest(readiness, "server_responsive", ownership === "proved");
  readiness = strongest(readiness, "joined", joined);
  readiness = strongest(readiness, "responsive", joined && responsiveClients === record.clients);

  const ambiguous = ownership === "ambiguous" || !capture.stable || contradictions.length > 0;
  const healthy = ownership === "proved" && joined;
  return {
    capturedAt: capture.captureFinishedAt,
    stable: capture.stable,
    possibleSimulation,
    ownership,
    readiness,
    health: ambiguous ? "indeterminate" : healthy ? "healthy" : possibleSimulation ? "degraded" : "indeterminate",
    ...(ownedServers.length === 1 ? { serverTargetId: ownedServers[0]!.id } : {}),
    clients: {
      ...(capture.processes.length === 0 ? {} : { processes: clients.length }),
      ...(capture.targets.length === 0 ? {} : { datamodels: clientTargets.length }),
      ...(server?.joined === undefined ? {} : { joined: server.joined }),
      ...(clientTargets.length === 0 ? {} : { responsive: responsiveClients }),
    },
    contradictions,
  };
}
