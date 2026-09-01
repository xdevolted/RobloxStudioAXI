import { describe, expect, it } from "vitest";
import { createManagedSession } from "../../src/session/managed-session.js";
import {
  FakeSessionEnvironment,
  FakeSessionEvidence,
  FakeSessionRepository,
  FakeSessionWorld,
} from "../../src/session/testing.js";
import type { SessionProjectIdentity } from "../../src/session/types.js";

const project: SessionProjectIdentity = {
  name: "FixtureGame",
  root: "c:\\games\\fixture",
  target: { kind: "local", path: "c:\\games\\fixture\\build.rbxlx" },
};

function fixture() {
  const repository = new FakeSessionRepository();
  const world = new FakeSessionWorld();
  const evidence = new FakeSessionEvidence();
  const environment = new FakeSessionEnvironment();
  return {
    repository,
    world,
    evidence,
    environment,
    managed: createManagedSession({ repository, world, evidence, environment }),
  };
}

describe("ManagedSession", () => {
  it("starts a joined Local Multiplayer Session from an absent state", async () => {
    const { managed, repository, world } = fixture();

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        schema_version: 1,
        command: "session.start",
        result: "started",
        changed: true,
        session: {
          state: "running",
          ownership: "proved",
          readiness: "joined",
          health: "healthy",
          project: "FixtureGame",
          clients: { requested: 2, processes: 2, datamodels: 2, joined: 2 },
        },
      },
    });
    expect(repository.record?.phase).toBe("running");
    expect(world.launches).toHaveLength(1);
  });

  it("treats a same-count start retry as a successful no-op", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const revision = repository.record?.revision;

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        command: "session.start",
        result: "already_running",
        changed: false,
        session: { state: "running", ownership: "proved", readiness: "joined" },
      },
    });
    expect(repository.record?.revision).toBe(revision);
    expect(world.launches).toHaveLength(1);
  });

  it("refuses a different client count without mutating the live session", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const record = structuredClone(repository.record);

    const outcome = await managed.start(
      { project, clients: 3 },
      { timeoutMs: 120_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        command: "session.start",
        result: "conflict",
        reason: "client_count_mismatch",
        changed: false,
        session: { state: "running", ownership: "proved" },
      },
    });
    expect(repository.record).toEqual(record);
    expect(world.launches).toHaveLength(1);
  });

  it("observes an absent session without transaction or evidence mutation", async () => {
    const { managed, evidence, repository } = fixture();

    const outcome = await managed.status({}, { timeoutMs: 30_000 });

    expect(outcome).toEqual({
      exitCode: 0,
      response: {
        schema_version: 1,
        command: "session.status",
        result: "observed",
        changed: false,
        session: {
          state: "absent",
          ownership: "none",
          readiness: "none",
          health: "not_applicable",
          clients: {},
        },
      },
    });
    expect(repository.record).toBeUndefined();
    expect(evidence.operations).toHaveLength(0);
  });

  it("stops an absent session as an evidenced no-op", async () => {
    const { managed, evidence } = fixture();

    const outcome = await managed.stop({}, { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        command: "session.stop",
        result: "already_stopped",
        changed: false,
        session: { state: "absent", ownership: "none" },
        evidence: "C:\\evidence\\operation-1",
      },
    });
    expect(evidence.operations).toHaveLength(1);
  });

  it("removes ownership only after guarded teardown is observed", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    const outcome = await managed.stop({}, { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        command: "session.stop",
        result: "stopped",
        changed: true,
        session: { state: "absent", ownership: "none", readiness: "none" },
        actions: [
          "record_marked_stopping",
          "end_test_requested",
          "teardown_verified",
          "record_removed",
        ],
      },
    });
    expect(world.endRequests).toHaveLength(1);
    expect(world.endRequests[0]?.serverTargetId).toBe("server-1");
    expect(repository.record).toBeUndefined();
  });

  it("refuses to launch beside recordless multiplayer state", async () => {
    const { managed, repository, world } = fixture();
    world.observation = {
      capturedAt: "2026-01-01T00:00:00.000Z",
      stable: true,
      possibleSimulation: true,
      ownership: "unmanaged",
      readiness: "datamodel_topology",
      health: "indeterminate",
      clients: { processes: 2, datamodels: 2 },
      contradictions: [],
    };

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        result: "conflict",
        reason: "unmanaged_studio_state",
        changed: false,
        session: { state: "unmanaged", ownership: "unmanaged" },
      },
    });
    expect(repository.record).toBeUndefined();
    expect(world.launches).toHaveLength(0);
  });

  it("does not launch when required observation surfaces are unavailable", async () => {
    const { managed, repository, world } = fixture();
    world.observation = {
      ...world.observation,
      stable: false,
      health: "indeterminate",
      contradictions: ["adapter: Studio MCP observation failed"],
    };

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    expect(outcome).toMatchObject({
      exitCode: 13,
      response: {
        result: "unsupported",
        reason: "control_surface_unavailable",
        changed: false,
        session: { state: "recovery_required", ownership: "ambiguous" },
      },
    });
    expect(repository.record).toBeUndefined();
    expect(world.launches).toHaveLength(0);
  });

  it("reports incomplete recordless status instead of claiming absence", async () => {
    const { managed, world } = fixture();
    world.observation = {
      ...world.observation,
      stable: false,
      health: "indeterminate",
      contradictions: ["adapter: Windows inventory failed"],
    };

    const outcome = await managed.status({}, { timeoutMs: 30_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        result: "observed",
        reason: "control_surface_unavailable",
        session: { state: "recovery_required", ownership: "ambiguous" },
      },
    });
  });

  it("reports an ownership contradiction as recovery-required status", async () => {
    const { managed, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      ...world.observation,
      ownership: "ambiguous",
      health: "indeterminate",
      contradictions: ["ownership tuple mismatch"],
    };

    const outcome = await managed.status({}, { timeoutMs: 30_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        result: "observed",
        session: { state: "recovery_required", ownership: "ambiguous" },
      },
    });
  });

  it("reports a proved running session without creating status evidence", async () => {
    const { managed, evidence } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    const outcome = await managed.status({}, { timeoutMs: 30_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        command: "session.status",
        result: "observed",
        changed: false,
        session: {
          state: "running",
          ownership: "proved",
          readiness: "joined",
          clients: { requested: 2, joined: 2 },
        },
      },
    });
    expect(evidence.operations).toHaveLength(1);
  });

  it("never tears down when live ownership cannot be re-proved", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      ...world.observation,
      ownership: "ambiguous",
      readiness: "process_topology",
      health: "indeterminate",
      contradictions: ["ownership tuple mismatch"],
    };
    delete world.observation.serverTargetId;
    const record = structuredClone(repository.record);

    const outcome = await managed.stop({}, { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      exitCode: 11,
      response: {
        result: "recovery_required",
        reason: "ownership_mismatch",
        changed: false,
        session: { state: "recovery_required", ownership: "ambiguous" },
      },
    });
    expect(world.endRequests).toHaveLength(0);
    expect(repository.record).toEqual(record);
  });

  it("refuses a start request for a different project", async () => {
    const { managed, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    const outcome = await managed.start(
      { project: { ...project, root: "c:\\games\\other" }, clients: 2 },
      { timeoutMs: 120_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        result: "conflict",
        reason: "project_mismatch",
        changed: false,
      },
    });
    expect(world.launches).toHaveLength(1);
  });

  it("terminates readiness polling at the command deadline", async () => {
    const { managed, repository, world } = fixture();
    world.advanceOnLaunch = false;

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 1_000 });

    expect(outcome).toMatchObject({
      exitCode: 6,
      response: {
        result: "timed_out",
        reason: "deadline_exceeded",
        changed: true,
        session: { state: "starting", ownership: "none", readiness: "none" },
      },
    });
    expect(repository.record?.phase).toBe("starting");
  });

  it("records interruption before creating ownership when the signal is already aborted", async () => {
    const { managed, repository, world, evidence } = fixture();
    const controller = new AbortController();
    controller.abort();

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: false,
        session: { state: "absent" },
      },
    });
    expect(repository.record).toBeUndefined();
    expect(world.launches).toHaveLength(0);
    expect(evidence.operations[0]?.outcome).toBeDefined();
  });

  it("retains stopping ownership when teardown cannot be verified by the deadline", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.advanceOnEnd = false;

    const outcome = await managed.stop({}, { timeoutMs: 1_000 });

    expect(outcome).toMatchObject({
      exitCode: 8,
      response: {
        result: "cleanup_failed",
        reason: "teardown_unverified",
        changed: true,
        session: { state: "stopping", ownership: "proved" },
      },
    });
    expect(repository.record?.phase).toBe("stopping");
  });

  it("retains stopping ownership while the supervised bootstrap remains", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observationAfterEnd = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: true,
      possibleSimulation: false,
      ownership: "recorded",
      readiness: "bootstrap",
      health: "indeterminate",
      clients: {},
      contradictions: [],
    };

    const outcome = await managed.stop({}, { timeoutMs: 1_000 });

    expect(outcome).toMatchObject({
      exitCode: 8,
      response: {
        result: "cleanup_failed",
        reason: "teardown_unverified",
        changed: true,
        session: { state: "stopping", readiness: "bootstrap" },
      },
    });
    expect(repository.record?.phase).toBe("stopping");
    expect(world.endRequests).toHaveLength(1);
  });

  it("retains stopping ownership when the teardown observation is ambiguous", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observationAfterEnd = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: false,
      possibleSimulation: false,
      ownership: "ambiguous",
      readiness: "none",
      health: "indeterminate",
      clients: {},
      contradictions: ["MCP target set changed during capture"],
    };

    const outcome = await managed.stop({}, { timeoutMs: 1_000 });

    expect(outcome).toMatchObject({
      exitCode: 8,
      response: {
        result: "cleanup_failed",
        reason: "teardown_unverified",
        session: { state: "stopping", ownership: "ambiguous" },
      },
    });
    expect(repository.record?.phase).toBe("stopping");
  });

  it("preserves stopping ownership when interrupted after EndTest", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const controller = new AbortController();
    world.onEnd = () => controller.abort();

    const outcome = await managed.stop(
      {},
      { timeoutMs: 60_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: true,
        session: { state: "stopping" },
      },
    });
    expect(repository.record?.phase).toBe("stopping");
    expect(world.endRequests).toHaveLength(1);
  });

  it("does not begin teardown when stop is interrupted during initial observation", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const controller = new AbortController();
    world.onObserve = () => controller.abort();

    const outcome = await managed.stop(
      {},
      { timeoutMs: 60_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: false,
        session: { state: "running" },
      },
    });
    expect(repository.record?.phase).toBe("running");
    expect(world.endRequests).toHaveLength(0);
  });

  it("preserves starting ownership when interrupted before ownership proof", async () => {
    const { managed, repository, world, environment } = fixture();
    const controller = new AbortController();
    world.advanceOnLaunch = false;
    environment.onSleep = () => controller.abort();

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: true,
        session: { state: "starting" },
      },
    });
    expect(repository.record?.phase).toBe("starting");
    expect(world.endRequests).toHaveLength(0);
  });

  it("cleans up an interrupted start after exact ownership proof", async () => {
    const { managed, repository, world, environment } = fixture();
    const controller = new AbortController();
    world.advanceOnLaunch = false;
    environment.onSleep = () => {
      world.observation = {
        capturedAt: "2026-01-01T00:00:01.000Z",
        stable: true,
        possibleSimulation: true,
        ownership: "proved",
        readiness: "server_responsive",
        health: "degraded",
        serverTargetId: "server-1",
        clients: { processes: 2, datamodels: 0, joined: 0 },
        contradictions: [],
      };
      controller.abort();
    };

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: true,
        session: { state: "absent", ownership: "none", readiness: "none" },
        actions: [
          "record_created",
          "bootstrap_started",
          "record_marked_stopping",
          "end_test_requested",
          "teardown_verified",
          "record_removed",
        ],
      },
    });
    expect(world.endRequests).toHaveLength(1);
    expect(repository.record).toBeUndefined();
  });

  it("cleans up when a start becomes joined as the signal arrives", async () => {
    const { managed, repository, world, environment } = fixture();
    const controller = new AbortController();
    world.advanceOnLaunch = false;
    environment.onSleep = () => {
      world.observation = {
        capturedAt: "2026-01-01T00:00:01.000Z",
        stable: true,
        possibleSimulation: true,
        ownership: "proved",
        readiness: "joined",
        health: "healthy",
        serverTargetId: "server-1",
        clients: { processes: 2, datamodels: 2, joined: 2 },
        contradictions: [],
      };
      controller.abort();
    };

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        session: { state: "absent", ownership: "none" },
      },
    });
    expect(world.endRequests).toHaveLength(1);
    expect(repository.record).toBeUndefined();
  });

  it("cleans up an interrupted resumed start after exact ownership proof", async () => {
    const { managed, repository, world, environment } = fixture();
    world.advanceOnLaunch = false;
    await managed.start({ project, clients: 2 }, { timeoutMs: 1_000 });
    const controller = new AbortController();
    environment.onSleep = () => {
      world.observation = {
        capturedAt: "2026-01-01T00:00:02.000Z",
        stable: true,
        possibleSimulation: true,
        ownership: "proved",
        readiness: "server_responsive",
        health: "degraded",
        serverTargetId: "server-1",
        clients: { processes: 2, datamodels: 0, joined: 0 },
        contradictions: [],
      };
      controller.abort();
    };

    const outcome = await managed.start(
      { project, clients: 2 },
      { timeoutMs: 120_000, signal: controller.signal },
    );

    expect(outcome).toMatchObject({
      exitCode: 12,
      response: {
        result: "interrupted",
        reason: "signal_received",
        changed: true,
        session: { state: "absent", ownership: "none", readiness: "none" },
        actions: [
          "record_marked_stopping",
          "end_test_requested",
          "teardown_verified",
          "record_removed",
        ],
      },
    });
    expect(world.launches).toHaveLength(1);
    expect(world.endRequests).toHaveLength(1);
    expect(repository.record).toBeUndefined();
  });

  it("clears a record only after a full stable absence window", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: true,
      possibleSimulation: false,
      ownership: "recorded",
      readiness: "none",
      health: "indeterminate",
      clients: {},
      contradictions: [],
    };

    const outcome = await managed.stop({}, { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        result: "stale_record_cleared",
        changed: true,
        session: { state: "absent", ownership: "none" },
        actions: ["stale_record_cleared", "record_removed"],
      },
    });
    expect(repository.record).toBeUndefined();
    expect(world.endRequests).toHaveLength(0);
  });

  it("preserves a possibly stale record when the proof window exceeds the deadline", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: true,
      possibleSimulation: false,
      ownership: "recorded",
      readiness: "none",
      health: "indeterminate",
      clients: {},
      contradictions: [],
    };
    const record = structuredClone(repository.record);

    const outcome = await managed.stop({}, { timeoutMs: 1_000 });

    expect(outcome).toMatchObject({
      exitCode: 6,
      response: { result: "timed_out", reason: "deadline_exceeded", changed: false },
    });
    expect(repository.record).toEqual(record);
    expect(world.endRequests).toHaveLength(0);
  });

  it("reports stable absent ownership as stale without mutating it", async () => {
    const { managed, repository, world, evidence } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: true,
      possibleSimulation: false,
      ownership: "recorded",
      readiness: "none",
      health: "indeterminate",
      clients: {},
      contradictions: [],
    };
    const record = structuredClone(repository.record);

    const outcome = await managed.status({}, { timeoutMs: 30_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: { result: "observed", changed: false, session: { state: "stale" } },
    });
    expect(repository.record).toEqual(record);
    expect(evidence.operations).toHaveLength(1);
  });

  it("repairs a safely stale record before launching a replacement session", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      capturedAt: "2026-01-01T00:00:02.000Z",
      stable: true,
      possibleSimulation: false,
      ownership: "recorded",
      readiness: "none",
      health: "indeterminate",
      clients: {},
      contradictions: [],
    };

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: {
        result: "started",
        changed: true,
        actions: [
          "stale_record_cleared",
          "record_created",
          "bootstrap_started",
          "record_marked_running",
        ],
      },
    });
    expect(repository.record?.phase).toBe("running");
    expect(world.launches).toHaveLength(2);
  });

  it("resumes a matching starting transition without launching another bootstrap", async () => {
    const { managed, repository, world } = fixture();
    world.advanceOnLaunch = false;
    await managed.start({ project, clients: 2 }, { timeoutMs: 1_000 });
    world.observation = {
      capturedAt: "2026-01-01T00:00:03.000Z",
      stable: true,
      possibleSimulation: true,
      ownership: "proved",
      readiness: "joined",
      health: "healthy",
      serverTargetId: "server-1",
      clients: { processes: 2, datamodels: 2, joined: 2 },
      contradictions: [],
    };

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    expect(outcome).toMatchObject({
      exitCode: 0,
      response: { result: "already_running", session: { state: "running" } },
    });
    expect(repository.record?.phase).toBe("running");
    expect(world.launches).toHaveLength(1);
  });

  it("treats an explicit mismatching stop project as a conflict", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const record = structuredClone(repository.record);

    const outcome = await managed.stop(
      { project: { ...project, root: "c:\\games\\other" } },
      { timeoutMs: 60_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: { result: "conflict", reason: "project_mismatch", changed: false },
    });
    expect(repository.record).toEqual(record);
    expect(world.endRequests).toHaveLength(0);
  });

  it("reports a stop project conflict despite unstable Studio observation", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const record = structuredClone(repository.record);
    world.observation = {
      ...world.observation,
      stable: false,
      ownership: "ambiguous",
      health: "indeterminate",
      contradictions: ["MCP target set changed during capture"],
    };

    const outcome = await managed.stop(
      { project: { ...project, root: "c:\\games\\other" } },
      { timeoutMs: 60_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        result: "conflict",
        reason: "project_mismatch",
        changed: false,
        session: { state: "running", ownership: "ambiguous" },
      },
    });
    expect(repository.record).toEqual(record);
    expect(world.endRequests).toHaveLength(0);
  });

  it("treats an explicit mismatching status project as a conflict", async () => {
    const { managed, repository, evidence } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    const record = structuredClone(repository.record);

    const outcome = await managed.status(
      { project: { ...project, root: "c:\\games\\other" } },
      { timeoutMs: 30_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        command: "session.status",
        result: "conflict",
        reason: "project_mismatch",
        changed: false,
      },
    });
    expect(repository.record).toEqual(record);
    expect(evidence.operations).toHaveLength(1);
  });

  it("reports a status project conflict despite unstable Studio observation", async () => {
    const { managed, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      ...world.observation,
      stable: false,
      ownership: "ambiguous",
      health: "indeterminate",
      contradictions: ["MCP target set changed during capture"],
    };

    const outcome = await managed.status(
      { project: { ...project, root: "c:\\games\\other" } },
      { timeoutMs: 30_000 },
    );

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        result: "conflict",
        reason: "project_mismatch",
        changed: false,
        session: { state: "running", ownership: "ambiguous" },
      },
    });
  });

  it("refuses generic cleanup authority for a recordless live simulation", async () => {
    const { managed, repository, world } = fixture();
    world.observation = {
      capturedAt: "2026-01-01T00:00:00.000Z",
      stable: true,
      possibleSimulation: true,
      ownership: "unmanaged",
      readiness: "datamodel_topology",
      health: "indeterminate",
      clients: { processes: 2, datamodels: 2 },
      contradictions: [],
    };

    const outcome = await managed.stop({}, { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      exitCode: 9,
      response: {
        result: "conflict",
        reason: "unmanaged_studio_state",
        changed: false,
        session: { state: "unmanaged", ownership: "unmanaged" },
      },
    });
    expect(repository.record).toBeUndefined();
    expect(world.endRequests).toHaveLength(0);
  });

  it("returns recovery required when a running record loses exact ownership", async () => {
    const { managed, repository, world } = fixture();
    await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });
    world.observation = {
      ...world.observation,
      ownership: "ambiguous",
      readiness: "process_topology",
      health: "indeterminate",
      contradictions: ["ownership mismatch"],
    };
    delete world.observation.serverTargetId;
    const record = structuredClone(repository.record);

    const outcome = await managed.start({ project, clients: 2 }, { timeoutMs: 120_000 });

    expect(outcome).toMatchObject({
      exitCode: 11,
      response: {
        result: "recovery_required",
        reason: "ownership_mismatch",
        changed: false,
      },
    });
    expect(repository.record).toEqual(record);
    expect(world.launches).toHaveLength(1);
  });
});
