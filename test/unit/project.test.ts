import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectRoot } from "../../src/project/discover.js";
import { loadProjectConfig } from "../../src/project/load-config.js";
import { loadPlaytestSpec } from "../../src/project/load-spec.js";
import { validateSpecSemantics } from "../../src/runner/test-runner.js";
import { RobloxAxiError } from "../../src/errors.js";
import { writeFixtureProject } from "../helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roblox-axi-project-"));
  temporary.push(root);
  return root;
}

describe("project discovery and configuration", () => {
  it("discovers .axi/config.toml upward from a nested directory", async () => {
    const root = await tempRoot();
    await writeFixtureProject(root);
    const nested = join(root, "src", "server");
    await mkdir(nested, { recursive: true });
    await expect(discoverProjectRoot({ startDirectory: nested })).resolves.toEqual({
      root,
      configPath: join(root, ".axi", "config.toml"),
    });
  });

  it("fails definitively when an explicit project is unconfigured", async () => {
    const root = await tempRoot();
    await expect(discoverProjectRoot({ explicitProject: root })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      exitCode: 2,
    });
  });

  it("resolves defaults and project-relative paths", async () => {
    const root = await tempRoot();
    await writeFixtureProject(root, 'local_place = "build/My Place.rbxlx"');
    const config = await loadProjectConfig({ explicitProject: root });
    expect(config.project.localPlace).toBe(join(root, "build", "My Place.rbxlx"));
    expect(config.testing.playtestsDirectory).toBe(join(root, "tests", "playtests"));
    expect(config.safety).toMatchObject({ environment: "test", allowPublish: false });
  });

  it("applies project configuration over optional global configuration", async () => {
    const root = await tempRoot();
    const appData = join(root, "appdata");
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    try {
      await mkdir(join(appData, "roblox-studio-axi"), { recursive: true });
      await writeFile(
        join(appData, "roblox-studio-axi", "config.toml"),
        '[studio]\nstartup_timeout_seconds = 99\n[evidence]\nscreenshots = "always"\n',
      );
      await writeFixtureProject(
        root,
        '[studio]\nstartup_timeout_seconds = 12\n[evidence]\nscreenshots = "never"',
      );
      const config = await loadProjectConfig({ explicitProject: root });
      expect(config.studio.startupTimeoutMs).toBe(12_000);
      expect(config.evidence.screenshots).toBe("never");
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
    }
  });

  it("reports schema paths for invalid configuration", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".axi"), { recursive: true });
    await writeFile(join(root, ".axi", "config.toml"), 'schema_version = 1\n[project]\nname = ""\n');
    await expect(loadProjectConfig({ explicitProject: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects a partial published-place identity", async () => {
    const root = await tempRoot();
    await writeFixtureProject(root, "place_id = 42");
    await expect(loadProjectConfig({ explicitProject: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("parses a playtest and rejects duplicate step IDs semantically", async () => {
    const root = await tempRoot();
    await writeFixtureProject(root);
    await mkdir(join(root, "tests", "playtests"), { recursive: true });
    const path = join(root, "tests", "playtests", "duplicate.yaml");
    await writeFile(
      path,
      'schema_version: 1\nid: duplicate\ntitle: Duplicate\nsteps:\n  - action: wait\n    id: same\n    duration_ms: 1\n  - action: wait\n    id: same\n    duration_ms: 1\ncleanup:\n  stop_playtest: true\n',
    );
    const config = await loadProjectConfig({ explicitProject: root });
    const loaded = await loadPlaytestSpec(config, path);
    expect(() => validateSpecSemantics(loaded.spec)).toThrowError(RobloxAxiError);
  });
});
