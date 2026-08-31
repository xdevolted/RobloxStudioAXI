import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionEvidence } from "../../src/session/evidence.js";
import { FakeSessionEnvironment } from "../../src/session/testing.js";
import { SESSION_PROTOCOL, type ManagedSessionRecord, type SessionOutcome } from "../../src/session/types.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSessionEvidence", () => {
  it("writes the manifest first, preserves bootstrap input, and writes result last", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-session-evidence-"));
    temporary.push(root);
    const evidence = new FileSessionEvidence({ root, environment: new FakeSessionEnvironment() });
    const operation = await evidence.begin("session.start", { clients: 2 });
    expect(await readdir(operation.directory)).toEqual(["manifest.json"]);
    const record: ManagedSessionRecord = {
      schemaVersion: 1,
      protocolVersion: 1,
      revision: 1,
      phase: "starting",
      ownership: {
        protocol: SESSION_PROTOCOL,
        sessionId: "session-1",
        projectRoot: "c:\\games\\fixture",
        launchTarget: "local:c:\\games\\fixture\\build.rbxlx",
        requestedClients: 2,
      },
      project: {
        name: "FixtureGame",
        root: "c:\\games\\fixture",
        target: { kind: "local", path: "c:\\games\\fixture\\build.rbxlx" },
      },
      clients: 2,
      controller: { pid: 100, createdAt: "2026-01-01T00:00:00.000Z" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      originatingEvidence: operation.directory,
      latestEvidence: operation.directory,
    };
    const artifacts = await operation.prepareBootstrap(record);
    expect(await readFile(artifacts.scriptPath, "utf8")).toContain("ExecuteMultiplayerTestAsync(2");
    const outcome: SessionOutcome = {
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
          clients: { requested: 2 },
        },
      },
    };

    await operation.finish(outcome);

    expect(JSON.parse(await readFile(join(operation.directory, "result.json"), "utf8"))).toMatchObject({
      exit_code: 0,
      response: { result: "started" },
    });
  });
});
