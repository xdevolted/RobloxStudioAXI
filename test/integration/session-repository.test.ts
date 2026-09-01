import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionRepository } from "../../src/session/repository.js";
import { FakeSessionEnvironment } from "../../src/session/testing.js";
import { SESSION_PROTOCOL, type ManagedSessionRecord } from "../../src/session/types.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileSessionRepository", () => {
  it("atomically persists a complete record for another controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-session-repo-"));
    temporary.push(root);
    const environment = new FakeSessionEnvironment();
    const first = new FileSessionRepository({ root, environment });
    const second = new FileSessionRepository({ root, environment });
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
      originatingEvidence: "C:\\evidence\\one",
      latestEvidence: "C:\\evidence\\one",
    };

    await first.transact("session.start", async (transaction) => transaction.write(record));

    await expect(second.read()).resolves.toEqual(record);
  });

  it("quarantines an abandoned transaction lock after repeated identity checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-session-repo-"));
    temporary.push(root);
    const lock = join(root, "transaction.lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce: "abandoned",
        command: "session.start",
        controller: { pid: 999, createdAt: "2025-01-01T00:00:00.000Z" },
        acquiredAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const repository = new FileSessionRepository({
      root,
      environment: new FakeSessionEnvironment(),
    });

    const value = await repository.transact("session.stop", async () => "recovered");

    expect(value).toBe("recovered");
  });

  it("does not mistake a reused PID for the original lock owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-session-repo-"));
    temporary.push(root);
    const lock = join(root, "transaction.lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce: "reused-pid",
        command: "session.start",
        controller: { pid: 100, createdAt: "2025-01-01T00:00:00.000Z" },
        acquiredAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const repository = new FileSessionRepository({
      root,
      environment: new FakeSessionEnvironment(),
    });

    await expect(repository.transact("session.stop", async () => "recovered")).resolves.toBe("recovered");
  });

  it("reports interruption instead of lock contention when cancellation wins the wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-session-repo-"));
    temporary.push(root);
    const lock = join(root, "transaction.lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce: "active",
        command: "session.start",
        controller: { pid: 100, createdAt: "2026-01-01T00:00:00.000Z" },
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const environment = new FakeSessionEnvironment();
    const controller = new AbortController();
    environment.onSleep = () => controller.abort();
    const repository = new FileSessionRepository({ root, environment });

    await expect(
      repository.transact(
        "session.stop",
        async () => "unexpected",
        { deadline: environment.now().getTime() + 5_000, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ reason: "interrupted" });
  });
});
