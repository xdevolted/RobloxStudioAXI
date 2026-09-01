export const SESSION_PROTOCOL = "roblox-studio-axi/managed-session/v1";

export type SessionCommand = "session.start" | "session.status" | "session.stop";
export type SessionPhase = "starting" | "running" | "stopping" | "recovery_required";
export type SessionState =
  | "absent"
  | "starting"
  | "running"
  | "stopping"
  | "stale"
  | "unmanaged"
  | "recovery_required";
export type SessionOwnership = "none" | "recorded" | "proved" | "unmanaged" | "ambiguous";
export type SessionReadiness =
  | "none"
  | "bootstrap"
  | "process_topology"
  | "datamodel_topology"
  | "server_responsive"
  | "joined"
  | "responsive";
export type SessionHealth = "not_applicable" | "healthy" | "degraded" | "indeterminate";

export interface ProcessIdentity {
  pid: number;
  createdAt: string;
}

export interface SessionProjectIdentity {
  name: string;
  root: string;
  target:
    | { kind: "local"; path: string }
    | { kind: "published"; placeId: number; universeId: number };
}

export interface SessionOwnershipTuple {
  protocol: typeof SESSION_PROTOCOL;
  sessionId: string;
  projectRoot: string;
  launchTarget: string;
  requestedClients: number;
}

export interface BootstrapIdentity extends ProcessIdentity {
  executable: string;
  scriptPath: string;
  logPath: string;
}

export interface ManagedSessionRecord {
  schemaVersion: 1;
  protocolVersion: 1;
  revision: number;
  phase: SessionPhase;
  ownership: SessionOwnershipTuple;
  project: SessionProjectIdentity;
  clients: number;
  controller: ProcessIdentity;
  bootstrap?: BootstrapIdentity;
  createdAt: string;
  updatedAt: string;
  originatingEvidence: string;
  latestEvidence: string;
}

export interface SessionObservation {
  capturedAt: string;
  stable: boolean;
  possibleSimulation: boolean;
  ownership: SessionOwnership;
  readiness: SessionReadiness;
  health: SessionHealth;
  serverTargetId?: string;
  clients: {
    processes?: number;
    datamodels?: number;
    joined?: number;
    responsive?: number;
  };
  contradictions: string[];
}

export interface SessionResponse {
  schema_version: 1;
  command: SessionCommand;
  result: string;
  reason?: string;
  changed: boolean;
  session: {
    state: SessionState;
    ownership: SessionOwnership;
    readiness: SessionReadiness;
    health: SessionHealth;
    id?: string;
    project?: string;
    clients: {
      requested?: number;
      processes?: number;
      datamodels?: number;
      joined?: number;
      responsive?: number;
    };
  };
  evidence?: string;
  help?: string[];
  actions?: string[];
  details?: {
    record?: ManagedSessionRecord;
    observation?: SessionObservation;
  };
}

export interface SessionOutcome {
  response: SessionResponse;
  exitCode: number;
}

export interface StartSessionRequest {
  project: SessionProjectIdentity;
  clients: number;
}

export interface StatusSessionRequest {
  project?: SessionProjectIdentity;
}

export interface StopSessionRequest {
  project?: SessionProjectIdentity;
}

export interface CommandContext {
  timeoutMs: number;
  signal?: AbortSignal;
  full?: boolean;
}

export interface SessionTransaction {
  read(): Promise<ManagedSessionRecord | undefined>;
  write(record: ManagedSessionRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface SessionRepository {
  read(): Promise<ManagedSessionRecord | undefined>;
  transact<T>(
    command: SessionCommand,
    work: (transaction: SessionTransaction) => Promise<T>,
    options?: { deadline: number; signal?: AbortSignal },
  ): Promise<T>;
}

export interface SessionWorld {
  observe(record?: ManagedSessionRecord): Promise<SessionObservation>;
  launch(record: ManagedSessionRecord, artifacts: BootstrapArtifacts): Promise<BootstrapIdentity>;
  endOwned(record: ManagedSessionRecord, serverTargetId: string): Promise<void>;
}

export interface BootstrapArtifacts {
  scriptPath: string;
  logPath: string;
}

export interface SessionOperation {
  readonly directory: string;
  prepareBootstrap(record: ManagedSessionRecord): Promise<BootstrapArtifacts>;
  appendObservation(observation: SessionObservation): Promise<void>;
  action(name: string): Promise<void>;
  finish(outcome: SessionOutcome): Promise<void>;
}

export interface SessionEvidence {
  begin(command: "session.start" | "session.stop", request: unknown): Promise<SessionOperation>;
}

export interface SessionEnvironment {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  id(): string;
  controller(): Promise<ProcessIdentity>;
  processExists(identity: ProcessIdentity): Promise<boolean>;
}

export interface ManagedSession {
  start(request: StartSessionRequest, context: CommandContext): Promise<SessionOutcome>;
  status(request: StatusSessionRequest, context: CommandContext): Promise<SessionOutcome>;
  stop(request: StopSessionRequest, context: CommandContext): Promise<SessionOutcome>;
}

export function launchTargetKey(project: SessionProjectIdentity): string {
  return project.target.kind === "local"
    ? `local:${project.target.path.replaceAll("/", "\\").toLocaleLowerCase()}`
    : `published:${project.target.universeId}:${project.target.placeId}`;
}
