import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { ResolvedProjectConfig } from "../types.js";
import type { SessionProjectIdentity } from "./types.js";

export function normalizeWindowsPath(path: string): string {
  const normalized = win32.normalize(path.replaceAll("/", "\\"));
  return /^[a-z]:/u.test(normalized)
    ? `${normalized[0]!.toLocaleUpperCase()}${normalized.slice(1)}`
    : normalized;
}

function comparablePath(path: string): string {
  return normalizeWindowsPath(path).toLocaleLowerCase();
}

export function sessionProjectsMatch(
  left: SessionProjectIdentity,
  right: SessionProjectIdentity,
): boolean {
  if (comparablePath(left.root) !== comparablePath(right.root)) return false;
  if (left.target.kind !== right.target.kind) return false;
  if (left.target.kind === "local" && right.target.kind === "local") {
    return comparablePath(left.target.path) === comparablePath(right.target.path);
  }
  return (
    left.target.kind === "published" &&
    right.target.kind === "published" &&
    left.target.placeId === right.target.placeId &&
    left.target.universeId === right.target.universeId
  );
}

export async function resolveSessionProjectIdentity(
  config: ResolvedProjectConfig,
): Promise<SessionProjectIdentity> {
  const root = normalizeWindowsPath(await realpath(config.root));
  if (config.project.localPlace !== undefined) {
    return {
      name: config.project.name,
      root,
      target: {
        kind: "local",
        path: normalizeWindowsPath(await realpath(config.project.localPlace)),
      },
    };
  }
  if (config.project.placeId !== undefined && config.project.universeId !== undefined) {
    return {
      name: config.project.name,
      root,
      target: {
        kind: "published",
        placeId: config.project.placeId,
        universeId: config.project.universeId,
      },
    };
  }
  throw new Error("Project has no launchable local or published target");
}
