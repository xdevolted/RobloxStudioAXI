import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { ExitCode, RobloxAxiError } from "../../errors.js";

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function discoverStudioExecutable(options: {
  configuredPath?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
} = {}): Promise<string> {
  if (options.configuredPath) {
    const configured = resolve(options.configuredPath);
    if (await isExecutableFile(configured)) return configured;
    throw new RobloxAxiError({
      message: `Configured Roblox Studio executable does not exist: ${configured}`,
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
    });
  }

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const executable = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio";
    if (await isExecutableFile(executable)) return executable;
  }

  if (platform === "win32") {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if (localAppData) {
      const versionsRoot = join(localAppData, "Roblox", "Versions");
      try {
        const candidates = await Promise.all(
          (await readdir(versionsRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const path = join(versionsRoot, entry.name, "RobloxStudioBeta.exe");
              if (!(await isExecutableFile(path))) return undefined;
              return { path, modified: (await stat(path)).mtimeMs };
            }),
        );
        const latest = candidates
          .filter((candidate): candidate is { path: string; modified: number } => Boolean(candidate))
          .sort((left, right) => right.modified - left.modified)[0];
        if (latest) return latest.path;
      } catch {
        // Fall through to the structured unavailable error.
      }
    }
  }

  throw new RobloxAxiError({
    message: "Roblox Studio executable was not found in a documented installation location",
    code: "STUDIO_UNAVAILABLE",
    exitCode: ExitCode.StudioUnavailable,
    suggestions: ["Install or update Roblox Studio", "Set studio.executable in .axi/config.toml"],
  });
}

export interface McpLaunch {
  command: string;
  args: string[];
}

export async function discoverMcpLaunch(options: {
  configuredCommand?: string;
  configuredArgs?: string[];
  platform?: NodeJS.Platform;
  localAppData?: string;
} = {}): Promise<McpLaunch> {
  if (options.configuredCommand) {
    return { command: options.configuredCommand, args: options.configuredArgs ?? [] };
  }

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const command = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
    if (await isExecutableFile(command)) return { command, args: [] };
  }

  if (platform === "win32") {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if (localAppData) {
      const launcher = join(localAppData, "Roblox", "mcp.bat");
      if (await isExecutableFile(launcher)) {
        // This is the exact Windows stdio launch mechanism documented by Roblox.
        return { command: "cmd.exe", args: ["/c", launcher] };
      }
    }
  }

  throw new RobloxAxiError({
    message: "The documented Roblox Studio MCP launcher was not found",
    code: "MCP_CONNECTION_FAILED",
    exitCode: ExitCode.McpFailure,
    suggestions: [
      "Enable Studio as an MCP server in Assistant settings",
      "Update Roblox Studio and verify its MCP quick-connect setup",
    ],
  });
}
