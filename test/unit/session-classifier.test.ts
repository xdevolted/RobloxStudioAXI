import { describe, expect, it } from "vitest";
import { classifySessionCapture } from "../../src/session/classifier.js";
import { SESSION_PROTOCOL, type ManagedSessionRecord } from "../../src/session/types.js";

const record: ManagedSessionRecord = {
  schemaVersion: 1,
  protocolVersion: 1,
  revision: 2,
  phase: "starting",
  ownership: {
    protocol: SESSION_PROTOCOL,
    sessionId: "session-1",
    projectRoot: "C:\\Games\\Fixture",
    launchTarget: "local:c:\\games\\fixture\\build.rbxlx",
    requestedClients: 2,
  },
  project: {
    name: "FixtureGame",
    root: "C:\\Games\\Fixture",
    target: { kind: "local", path: "C:\\Games\\Fixture\\build.rbxlx" },
  },
  clients: 2,
  controller: { pid: 100, createdAt: "2026-01-01T00:00:00.000Z" },
  bootstrap: {
    pid: 200,
    createdAt: "2026-01-01T00:00:01.000Z",
    executable: "RobloxStudioBeta.exe",
    scriptPath: "C:\\evidence\\bootstrap.luau",
    logPath: "C:\\evidence\\bootstrap.log",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  originatingEvidence: "C:\\evidence\\one",
  latestEvidence: "C:\\evidence\\one",
};

describe("Managed Session classification", () => {
  it("does not classify one in-process play target as Local Multiplayer", () => {
    const observation = classifySessionCapture(undefined, {
      captureStartedAt: "2026-01-01T00:00:00.000Z",
      captureFinishedAt: "2026-01-01T00:00:00.100Z",
      stable: true,
      processes: [
        {
          identity: { pid: 10, createdAt: "2026-01-01T00:00:00.000Z" },
          parentPid: 1,
          role: "edit",
        },
      ],
      targets: [{ id: "studio-1", context: "client", loaded: true, hasLocalPlayer: true }],
      failures: [],
      contradictions: [],
    });

    expect(observation).toMatchObject({
      possibleSimulation: false,
      ownership: "none",
      health: "not_applicable",
    });
  });

  it("derives responsive readiness only from exact stable process and MCP evidence", () => {
    const observation = classifySessionCapture(record, {
      captureStartedAt: "2026-01-01T00:00:02.000Z",
      captureFinishedAt: "2026-01-01T00:00:03.000Z",
      stable: true,
      processes: [
        { identity: record.bootstrap!, parentPid: 100, role: "bootstrap" },
        { identity: { pid: 300, createdAt: "2026-01-01T00:00:02.000Z" }, parentPid: 200, role: "server" },
        { identity: { pid: 301, createdAt: "2026-01-01T00:00:02.100Z" }, parentPid: 300, role: "client" },
        { identity: { pid: 302, createdAt: "2026-01-01T00:00:02.200Z" }, parentPid: 300, role: "client" },
      ],
      targets: [
        { id: "server", context: "server", ownership: record.ownership, joined: 2 },
        { id: "client-1", context: "client", ownership: record.ownership, loaded: true, hasLocalPlayer: true },
        { id: "client-2", context: "client", ownership: record.ownership, loaded: true, hasLocalPlayer: true },
      ],
      failures: [],
      contradictions: [],
    });

    expect(observation).toMatchObject({
      stable: true,
      ownership: "proved",
      readiness: "responsive",
      health: "healthy",
      serverTargetId: "server",
      clients: { processes: 2, datamodels: 2, joined: 2, responsive: 2 },
    });
  });

  it("treats a candidate process without creation time as ambiguous", () => {
    const observation = classifySessionCapture(record, {
      captureStartedAt: "2026-01-01T00:00:02.000Z",
      captureFinishedAt: "2026-01-01T00:00:03.000Z",
      stable: true,
      processes: [{ parentPid: 200, role: "server" }],
      targets: [{ id: "server", context: "server", ownership: record.ownership, joined: 2 }],
      failures: [],
      contradictions: [],
    });

    expect(observation).toMatchObject({
      ownership: "ambiguous",
      health: "indeterminate",
    });
  });
});
