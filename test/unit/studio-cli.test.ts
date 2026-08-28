import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApiDumpArguments,
  buildOpenArguments,
  buildRunScriptArguments,
} from "../../src/studio/cli/args.js";
import { discoverMcpLaunch, discoverStudioExecutable } from "../../src/studio/cli/discover.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("documented Studio CLI construction", () => {
  it("keeps a local path with spaces as one spawn argument", () => {
    const path = join(process.cwd(), "Fixtures With Spaces", "Game.rbxlx");
    const args = buildOpenArguments({ kind: "local", localPlaceFile: path });
    expect(args).toEqual(["--task", "EditFile", "--localPlaceFile", path]);
  });

  it("constructs published EditPlace arguments", () => {
    expect(buildOpenArguments({ kind: "published", placeId: 42, universeId: 84 })).toEqual([
      "--task",
      "EditPlace",
      "--placeId",
      "42",
      "--universeId",
      "84",
    ]);
  });

  it("constructs RunScript, output, quit, and API dump arguments without shell quoting", () => {
    const script = join(process.cwd(), "Probe Files", "smoke.luau");
    const output = join(process.cwd(), "Probe Files", "out.log");
    expect(
      buildRunScriptArguments({ scriptFile: script, outputFile: output, quitAfterExecution: true }),
    ).toEqual([
      "--task",
      "RunScript",
      "--runScriptFile",
      script,
      "--outputFile",
      output,
      "--quitAfterExecution",
    ]);
    expect(buildApiDumpArguments("apiV2", output)).toEqual(["--apiV2", output]);
  });

  it("chooses the newest documented Windows Studio executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-studio-"));
    temporary.push(root);
    const oldPath = join(root, "Roblox", "Versions", "version-old", "RobloxStudioBeta.exe");
    const newPath = join(root, "Roblox", "Versions", "version-new", "RobloxStudioBeta.exe");
    await mkdir(join(oldPath, ".."), { recursive: true });
    await mkdir(join(newPath, ".."), { recursive: true });
    await writeFile(oldPath, "old");
    await writeFile(newPath, "new");
    await utimes(oldPath, new Date(1_000), new Date(1_000));
    await utimes(newPath, new Date(2_000), new Date(2_000));
    await expect(
      discoverStudioExecutable({ platform: "win32", localAppData: root }),
    ).resolves.toBe(newPath);
  });

  it("uses Roblox's documented Windows MCP batch launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-mcp-"));
    temporary.push(root);
    const launcher = join(root, "Roblox", "mcp.bat");
    await mkdir(join(launcher, ".."), { recursive: true });
    await writeFile(launcher, "@echo off\n");
    await expect(discoverMcpLaunch({ platform: "win32", localAppData: root })).resolves.toEqual({
      command: "cmd.exe",
      args: ["/c", launcher],
    });
  });
});
