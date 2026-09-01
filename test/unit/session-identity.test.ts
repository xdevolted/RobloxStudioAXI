import { describe, expect, it } from "vitest";
import { sessionProjectsMatch } from "../../src/session/identity.js";

describe("Managed Session project identity", () => {
  it("compares Windows project and local target paths case-insensitively", () => {
    expect(
      sessionProjectsMatch(
        {
          name: "One",
          root: "C:\\Games\\Fixture",
          target: { kind: "local", path: "C:\\Games\\Fixture\\Build.rbxlx" },
        },
        {
          name: "Renamed display metadata",
          root: "c:/games/fixture",
          target: { kind: "local", path: "c:/GAMES/FIXTURE/build.rbxlx" },
        },
      ),
    ).toBe(true);
  });
});
