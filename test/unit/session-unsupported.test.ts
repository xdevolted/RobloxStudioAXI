import { describe, expect, it } from "vitest";
import { createUnsupportedManagedSession } from "../../src/session/unsupported.js";
import { FakeSessionEvidence } from "../../src/session/testing.js";

describe("unsupported Managed Session platform", () => {
  it("returns exit 13 and writes evidence for mutation attempts", async () => {
    const evidence = new FakeSessionEvidence();
    const session = createUnsupportedManagedSession(evidence);

    const start = await session.start(
      {
        project: {
          name: "FixtureGame",
          root: "c:\\games\\fixture",
          target: { kind: "local", path: "c:\\games\\fixture\\build.rbxlx" },
        },
        clients: 2,
      },
      { timeoutMs: 1 },
    );
    const status = await session.status({}, { timeoutMs: 1 });
    const stop = await session.stop({}, { timeoutMs: 1 });

    expect(start).toMatchObject({
      exitCode: 13,
      response: { result: "unsupported", reason: "platform_unsupported", evidence: expect.any(String) },
    });
    expect(status).toMatchObject({
      exitCode: 13,
      response: { result: "unsupported", reason: "platform_unsupported" },
    });
    expect(status.response).not.toHaveProperty("evidence");
    expect(stop).toMatchObject({
      exitCode: 13,
      response: { result: "unsupported", reason: "platform_unsupported", evidence: expect.any(String) },
    });
    expect(evidence.operations).toHaveLength(2);
    expect(evidence.operations.every((operation) => operation.outcome?.exitCode === 13)).toBe(true);
  });
});
