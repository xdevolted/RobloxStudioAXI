import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PlaytestSpec, ResolvedProjectConfig, WorkflowSpec } from "../types.js";
import { validateSchema } from "./schema.js";

function resolveInputPath(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

async function loadYaml(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, "utf8"));
}

export async function loadPlaytestSpec(
  config: ResolvedProjectConfig,
  path: string,
): Promise<{ path: string; spec: PlaytestSpec; source: string }> {
  const resolvedPath = resolveInputPath(config.root, path);
  const source = await readFile(resolvedPath, "utf8");
  const spec = await validateSchema<PlaytestSpec>("playtest-spec", parseYaml(source));
  return { path: resolvedPath, spec, source };
}

export async function loadWorkflowSpec(
  config: ResolvedProjectConfig,
  nameOrPath: string,
): Promise<{ path: string; workflow: WorkflowSpec }> {
  const looksLikePath = /[\\/]/u.test(nameOrPath) || /\.ya?ml$/iu.test(nameOrPath);
  const resolvedPath = looksLikePath
    ? resolveInputPath(config.root, nameOrPath)
    : resolve(config.testing.workflowsDirectory, `${nameOrPath}.yaml`);
  const workflow = await validateSchema<WorkflowSpec>("workflow", await loadYaml(resolvedPath));
  return { path: resolvedPath, workflow };
}
