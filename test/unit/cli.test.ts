import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "dist", "bin", "roblox-studio-axi.js");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function timed(args: string[]): Promise<number> {
  const start = performance.now();
  await execFileAsync(process.execPath, args, { windowsHide: true });
  return performance.now() - start;
}

describe("CLI contract", () => {
  it("prints a bare version through every fast-path alias", async () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const result = await execFileAsync(process.execPath, [cli, flag], { windowsHide: true });
      expect(result.stdout).toBe("0.1.0\n");
    }
  });

  it("keeps the version path near the node process floor", async () => {
    const floor = await timed(["-e", "console.log(1)"]);
    const version = await timed([cli, "--version"]);
    expect(version).toBeLessThan(floor * 3 + 75);
  });

  it("fails loud on an unknown flag with exit code 2 and valid flags inline", async () => {
    await expect(execFileAsync(process.execPath, [cli, "version", "--versoin"], { windowsHide: true })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("Unknown flag --versoin"),
    });
  });

  it("supports JSON output for a self-contained command", async () => {
    const result = await execFileAsync(process.execPath, [cli, "version", "--json"], { windowsHide: true });
    expect(JSON.parse(result.stdout)).toEqual({ version: "0.1.0" });
  });

  it("returns stable exit 5 for an MCP connection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "roblox-axi-cli-"));
    temporary.push(root);
    await mkdir(join(root, ".axi"), { recursive: true });
    await writeFile(
      join(root, ".axi", "config.toml"),
      `schema_version = 1\n[project]\nname = "Fixture"\n[studio]\nmcp_command = ${JSON.stringify(process.execPath)}\nmcp_args = ["-e", "process.exit(1)"]\n`,
    );
    await expect(
      execFileAsync(
        process.execPath,
        [cli, "studios", "list", "--project", root, "--json"],
        { windowsHide: true },
      ),
    ).rejects.toMatchObject({
      code: 5,
      stdout: expect.stringContaining('"code": "MCP_CONNECTION_FAILED"'),
    });
  });

  it("validates managed-session client count before project or Studio access", async () => {
    await expect(
      execFileAsync(process.execPath, [cli, "session", "start", "--clients", "0"], {
        windowsHide: true,
      }),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("--clients is required and must be an integer from 1 through 8"),
    });
  });

  it("rejects Studio selection and ownership-bypass flags on session commands", async () => {
    for (const flag of ["--studio", "--force", "--adopt", "--kill"]) {
      await expect(
        execFileAsync(process.execPath, [cli, "session", "status", flag, "value"], {
          windowsHide: true,
        }),
      ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining(`Unknown flag ${flag}`) });
    }
  });
});
