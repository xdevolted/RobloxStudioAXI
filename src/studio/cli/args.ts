import { isAbsolute, resolve } from "node:path";
import { ExitCode, RobloxAxiError } from "../../errors.js";

export type StudioOpenTarget =
  | { kind: "local"; localPlaceFile: string }
  | { kind: "published"; placeId: number; universeId: number; placeVersion?: number };

function absolutePath(path: string, label: string): string {
  const value = isAbsolute(path) ? path : resolve(path);
  if (!isAbsolute(value)) {
    throw new RobloxAxiError({
      message: `${label} must be an absolute path`,
      code: "CONFIG_INVALID",
      exitCode: ExitCode.InvalidInput,
    });
  }
  return value;
}

export function buildOpenArguments(target: StudioOpenTarget): string[] {
  if (target.kind === "local") {
    return ["--task", "EditFile", "--localPlaceFile", absolutePath(target.localPlaceFile, "Local place")];
  }
  const args = [
    "--task",
    target.placeVersion === undefined ? "EditPlace" : "EditPlaceRevision",
    "--placeId",
    String(target.placeId),
    "--universeId",
    String(target.universeId),
  ];
  if (target.placeVersion !== undefined) {
    args.push("--placeVersion", String(target.placeVersion));
  }
  return args;
}

export function buildRunScriptArguments(options: {
  scriptFile: string;
  outputFile?: string;
  quitAfterExecution?: boolean;
  target?: StudioOpenTarget;
}): string[] {
  const args = ["--task", "RunScript"];
  if (options.target?.kind === "local") {
    args.push("--localPlaceFile", absolutePath(options.target.localPlaceFile, "Local place"));
  } else if (options.target?.kind === "published") {
    args.push(
      "--placeId",
      String(options.target.placeId),
      "--universeId",
      String(options.target.universeId),
    );
  }
  args.push("--runScriptFile", absolutePath(options.scriptFile, "RunScript file"));
  if (options.outputFile) {
    args.push("--outputFile", absolutePath(options.outputFile, "RunScript output"));
  }
  if (options.quitAfterExecution) {
    args.push("--quitAfterExecution");
  }
  return args;
}

export function buildApiDumpArguments(
  format: "api" | "fullApi" | "apiV2",
  outputFile: string,
): string[] {
  return [`--${format}`, absolutePath(outputFile, "API dump output")];
}
