import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProjectConfig } from "../src/types.js";

export function resolvedConfig(root: string): ResolvedProjectConfig {
  return {
    schemaVersion: 1,
    root,
    configPath: join(root, ".axi", "config.toml"),
    project: { name: "FixtureGame", expectedPlaceName: "FixtureGame" },
    studio: { mcpArgs: [], startupTimeoutMs: 200, operationTimeoutMs: 100 },
    testing: {
      playtestsDirectory: join(root, "tests", "playtests"),
      workflowsDirectory: join(root, ".axi", "workflows"),
      defaultWorkflow: "smoke",
    },
    evidence: {
      directory: join(root, ".artifacts", "playtests"),
      screenshots: "on_failure",
      console: "errors_and_warnings",
    },
    safety: {
      environment: "test",
      allowPublish: false,
      allowLiveDatastores: false,
      alwaysStopPlaytest: true,
    },
  };
}

export async function writeFixtureProject(root: string, extra = ""): Promise<void> {
  await mkdir(join(root, ".axi"), { recursive: true });
  await writeFile(
    join(root, ".axi", "config.toml"),
    `schema_version = 1\n\n[project]\nname = "FixtureGame"\n${extra}\n`,
  );
}
