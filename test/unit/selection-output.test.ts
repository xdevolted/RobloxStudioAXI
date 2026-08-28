import { describe, expect, it } from "vitest";
import { normalizeCapabilities, requireCapabilities, ToolName } from "../../src/studio/mcp/capabilities.js";
import { selectStudio } from "../../src/studio/selection.js";
import { consoleDelta } from "../../src/studio/service.js";
import { truncate } from "../../src/app.js";
import { compactRunResult, jsonOutput } from "../../src/output.js";
import { pollUntil, withTimeout } from "../../src/runner/timeout.js";
import { resolvedConfig } from "../helpers.js";

describe("selection, capabilities, output, and timeout behavior", () => {
  it("normalizes capabilities and reports a missing required tool", () => {
    const capabilities = normalizeCapabilities([
      { name: ToolName.ListStudios, inputSchema: {} },
      { name: ToolName.StudioState, inputSchema: {} },
    ]);
    expect(capabilities.supported.list_roblox_studios).toBe(true);
    expect(() => requireCapabilities(capabilities, [ToolName.ScreenCapture])).toThrowError(
      /screen_capture/u,
    );
  });

  it("selects explicitly, by place, by name, or as the only Studio", () => {
    const config = resolvedConfig("C:\\fixture");
    const studios = [
      { id: "a", name: "Other", placeId: 11 },
      { id: "b", name: "FixtureGame", placeId: 22 },
    ];
    expect(selectStudio({ studios, config, explicitStudioId: "a" }).id).toBe("a");
    expect(selectStudio({ studios, config }).id).toBe("b");
    expect(selectStudio({ studios: [studios[0]!], config }).id).toBe("a");
    config.project.placeId = 22;
    delete config.project.expectedPlaceName;
    expect(selectStudio({ studios, config }).id).toBe("b");
  });

  it("refuses zero and ambiguous Studio selection", () => {
    const config = resolvedConfig("C:\\fixture");
    delete config.project.expectedPlaceName;
    expect(() => selectStudio({ studios: [], config })).toThrowError(/No Roblox Studio/u);
    expect(() =>
      selectStudio({ studios: [{ id: "a", name: "A" }, { id: "b", name: "B" }], config }),
    ).toThrowError(/ambiguous/u);
  });

  it("returns only console entries after the captured baseline", () => {
    const before = [{ level: "info" as const, message: "old" }];
    const after = [...before, { level: "error" as const, message: "new" }];
    expect(consoleDelta(before, after)).toEqual([{ level: "error", message: "new" }]);
  });

  it("truncates with total size and emits machine-readable JSON", () => {
    expect(truncate("abcdef", 3)).toBe("abc... (truncated, 6 chars total)");
    expect(JSON.parse(jsonOutput({ status: "passed" }))).toEqual({ status: "passed" });
  });

  it("formats a compact result with pre-computed counts", () => {
    const output = compactRunResult({
      schema_version: 1,
      run_id: "run",
      test_id: "smoke",
      status: "passed",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      duration_ms: 1000,
      last_studio_state: "edit",
      assertions: { passed: 2, failed: 0, results: [] },
      console: { errors: 0, warnings: 1, path: "console.log" },
      cleanup: { status: "passed", stop_attempted: true },
      evidence: { directory: ".artifacts/run", screenshots: [] },
    });
    expect(output).toMatchObject({ assertions: "2 passed, 0 failed", console: "0 errors, 1 warnings" });
  });

  it("identifies the operation that timed out and polls safe reads", async () => {
    await expect(withTimeout("slow read", 5, () => new Promise(() => undefined))).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    let count = 0;
    await expect(
      pollUntil({ operation: "readiness", timeoutMs: 100, intervalMs: 1, read: async () => ++count, accept: (value) => value === 3 }),
    ).resolves.toBe(3);
  });
});
