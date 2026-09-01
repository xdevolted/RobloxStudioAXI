import { describe, expect, it } from "vitest";
import { normalizeWindowsProcessRows } from "../../src/session/windows.js";

describe("Windows process inventory normalization", () => {
  it("pairs PID with normalized creation time and treats roles as corroboration", () => {
    expect(
      normalizeWindowsProcessRows([
        {
          ProcessId: 42,
          ParentProcessId: 10,
          CreationDate: "2026-08-31T12:34:56.000000+000",
          ExecutablePath: "C:\\Roblox\\RobloxStudioBeta.exe",
          CommandLine: 'RobloxStudioBeta.exe -task StartServer -playTestSessionGuid "abc"',
        },
      ]),
    ).toEqual([
      {
        identity: { pid: 42, createdAt: "2026-08-31T12:34:56.000Z" },
        parentPid: 10,
        executable: "C:\\Roblox\\RobloxStudioBeta.exe",
        commandLine: 'RobloxStudioBeta.exe -task StartServer -playTestSessionGuid "abc"',
        role: "server",
      },
    ]);
  });
});
