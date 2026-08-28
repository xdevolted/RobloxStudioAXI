import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { ExitCode, RobloxAxiError } from "../errors.js";

const CONFIG_RELATIVE_PATH = ".axi/config.toml";

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverProjectRoot(options: {
  startDirectory?: string;
  explicitProject?: string;
} = {}): Promise<{ root: string; configPath: string }> {
  const start = resolve(options.explicitProject ?? options.startDirectory ?? process.cwd());
  let current = start;

  while (true) {
    const configPath = resolve(current, CONFIG_RELATIVE_PATH);
    if (await isReadableFile(configPath)) {
      return { root: current, configPath };
    }

    if (options.explicitProject) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new RobloxAxiError({
    message: `No ${CONFIG_RELATIVE_PATH} was found from ${start}`,
    code: "PROJECT_NOT_FOUND",
    exitCode: ExitCode.InvalidInput,
    suggestions: [
      "Run from a configured game directory",
      "Run `roblox-studio-axi project inspect --project <path>`",
      `Create ${CONFIG_RELATIVE_PATH} in the game repository`,
    ],
  });
}
