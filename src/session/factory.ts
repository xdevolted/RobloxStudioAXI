import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProjectConfig } from "../types.js";
import { FileSessionEvidence } from "./evidence.js";
import { createManagedSession } from "./managed-session.js";
import { FileSessionRepository } from "./repository.js";
import { ProductionSessionWorld } from "./world.js";
import { ProductionSessionEnvironment } from "./windows.js";
import { createUnsupportedManagedSession } from "./unsupported.js";

export function managedSessionRoot(localAppData = process.env.LOCALAPPDATA): string {
  const base = localAppData ?? join(homedir(), "AppData", "Local");
  return resolve(base, "roblox-studio-axi", "sessions", "v1");
}

export function createProductionManagedSession(options: {
  config?: ResolvedProjectConfig;
  localAppData?: string;
  platform?: NodeJS.Platform;
} = {}) {
  const environment = new ProductionSessionEnvironment();
  const root = managedSessionRoot(options.localAppData);
  const evidence = new FileSessionEvidence({ root: join(root, "evidence"), environment });
  if ((options.platform ?? process.platform) !== "win32") {
    return createUnsupportedManagedSession(evidence);
  }
  return createManagedSession({
    environment,
    repository: new FileSessionRepository({ root, environment }),
    evidence,
    world: new ProductionSessionWorld({
      ...(options.config === undefined ? {} : { config: options.config }),
    }),
  });
}
