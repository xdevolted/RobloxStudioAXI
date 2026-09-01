import type {
  BootstrapArtifacts,
  BootstrapIdentity,
  ManagedSessionRecord,
  ProcessIdentity,
  SessionCommand,
  SessionEnvironment,
  SessionEvidence,
  SessionObservation,
  SessionOperation,
  SessionOutcome,
  SessionRepository,
  SessionTransaction,
  SessionWorld,
} from "./types.js";

export class FakeSessionRepository implements SessionRepository, SessionTransaction {
  record: ManagedSessionRecord | undefined;

  read(): Promise<ManagedSessionRecord | undefined> {
    return Promise.resolve(this.record === undefined ? undefined : structuredClone(this.record));
  }

  async transact<T>(
    _command: SessionCommand,
    work: (transaction: SessionTransaction) => Promise<T>,
    _options?: { deadline: number; signal?: AbortSignal },
  ): Promise<T> {
    return work(this);
  }

  write(record: ManagedSessionRecord): Promise<void> {
    this.record = structuredClone(record);
    return Promise.resolve();
  }

  remove(): Promise<void> {
    this.record = undefined;
    return Promise.resolve();
  }
}

export class FakeSessionWorld implements SessionWorld {
  launches: ManagedSessionRecord[] = [];
  endRequests: Array<{ record: ManagedSessionRecord; serverTargetId: string }> = [];
  advanceOnLaunch = true;
  advanceOnEnd = true;
  onEnd: (() => void) | undefined;
  observationAfterEnd: SessionObservation | undefined;
  observation: SessionObservation = {
    capturedAt: "2026-01-01T00:00:00.000Z",
    stable: true,
    possibleSimulation: false,
    ownership: "none",
    readiness: "none",
    health: "not_applicable",
    clients: {},
    contradictions: [],
  };

  observe(): Promise<SessionObservation> {
    return Promise.resolve(structuredClone(this.observation));
  }

  launch(record: ManagedSessionRecord, _artifacts: BootstrapArtifacts): Promise<BootstrapIdentity> {
    this.launches.push(structuredClone(record));
    if (this.advanceOnLaunch) {
      this.observation = {
        capturedAt: "2026-01-01T00:00:01.000Z",
        stable: true,
        possibleSimulation: true,
        ownership: "proved",
        readiness: "joined",
        health: "healthy",
        serverTargetId: "server-1",
        clients: {
          processes: record.clients,
          datamodels: record.clients,
          joined: record.clients,
        },
        contradictions: [],
      };
    }
    return Promise.resolve({
      pid: 200,
      createdAt: "2026-01-01T00:00:00.500Z",
      executable: "RobloxStudioBeta.exe",
      scriptPath: "C:\\evidence\\bootstrap.luau",
      logPath: "C:\\evidence\\bootstrap.log",
    });
  }

  endOwned(record: ManagedSessionRecord, serverTargetId: string): Promise<void> {
    this.endRequests.push({ record: structuredClone(record), serverTargetId });
    if (this.observationAfterEnd !== undefined) {
      this.observation = structuredClone(this.observationAfterEnd);
    } else if (this.advanceOnEnd) {
      this.observation = {
        ...this.observation,
        possibleSimulation: false,
        ownership: "none",
        readiness: "none",
        health: "not_applicable",
        clients: {},
      };
    }
    this.onEnd?.();
    return Promise.resolve();
  }
}

class FakeOperation implements SessionOperation {
  readonly directory = "C:\\evidence\\operation-1";
  readonly actions: string[] = [];
  outcome: SessionOutcome | undefined;

  prepareBootstrap(): Promise<BootstrapArtifacts> {
    return Promise.resolve({
      scriptPath: `${this.directory}\\bootstrap.luau`,
      logPath: `${this.directory}\\bootstrap.log`,
    });
  }

  appendObservation(): Promise<void> {
    return Promise.resolve();
  }

  action(name: string): Promise<void> {
    this.actions.push(name);
    return Promise.resolve();
  }

  finish(outcome: SessionOutcome): Promise<void> {
    this.outcome = structuredClone(outcome);
    return Promise.resolve();
  }
}

export class FakeSessionEvidence implements SessionEvidence {
  operations: FakeOperation[] = [];

  begin(): Promise<SessionOperation> {
    const operation = new FakeOperation();
    this.operations.push(operation);
    return Promise.resolve(operation);
  }
}

export class FakeSessionEnvironment implements SessionEnvironment {
  #now = new Date("2026-01-01T00:00:00.000Z");
  #id = 0;
  onSleep: (() => void) | undefined;

  now(): Date {
    return new Date(this.#now);
  }

  sleep(milliseconds: number): Promise<void> {
    this.#now = new Date(this.#now.getTime() + milliseconds);
    this.onSleep?.();
    return Promise.resolve();
  }

  id(): string {
    this.#id += 1;
    return `00000000-0000-4000-8000-${String(this.#id).padStart(12, "0")}`;
  }

  controller(): Promise<ProcessIdentity> {
    return Promise.resolve({ pid: 100, createdAt: "2026-01-01T00:00:00.000Z" });
  }

  processExists(identity: ProcessIdentity): Promise<boolean> {
    return Promise.resolve(
      identity.pid === 100 && identity.createdAt === "2026-01-01T00:00:00.000Z",
    );
  }
}
