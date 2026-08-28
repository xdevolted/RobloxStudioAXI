import { ExitCode, RobloxAxiError } from "../errors.js";
import type { ResolvedProjectConfig, StudioInstance } from "../types.js";

function compact(studios: StudioInstance[]): Array<Record<string, unknown>> {
  return studios.map((studio) => ({
    id: studio.id,
    name: studio.name,
    ...(studio.placeId === undefined ? {} : { place_id: studio.placeId }),
  }));
}

export function selectStudio(options: {
  studios: StudioInstance[];
  config: ResolvedProjectConfig;
  explicitStudioId?: string;
}): StudioInstance {
  const { studios, config, explicitStudioId } = options;
  if (explicitStudioId) {
    const match = studios.find((studio) => studio.id === explicitStudioId);
    if (match) return match;
    throw new RobloxAxiError({
      message: `Studio ${explicitStudioId} is not connected`,
      code: "STUDIO_UNAVAILABLE",
      exitCode: ExitCode.StudioUnavailable,
      suggestions: ["Run `roblox-studio-axi studios list`"],
      details: { studios: compact(studios) },
    });
  }

  let candidates = studios;
  if (config.project.placeId !== undefined) {
    const byPlace = candidates.filter((studio) => studio.placeId === config.project.placeId);
    if (byPlace.length === 1) return byPlace[0]!;
    if (byPlace.length > 0) candidates = byPlace;
  }

  if (config.project.expectedPlaceName) {
    const expected = config.project.expectedPlaceName.toLocaleLowerCase();
    const byName = candidates.filter((studio) => studio.name.toLocaleLowerCase() === expected);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 0) candidates = byName;
  }

  if (candidates.length === 1) return candidates[0]!;
  if (studios.length === 0) {
    throw new RobloxAxiError({
      message: "No Roblox Studio instances are connected to Studio MCP",
      code: "STUDIO_UNAVAILABLE",
      exitCode: ExitCode.StudioUnavailable,
      suggestions: [
        "Open the configured place in Studio",
        "Enable Studio as an MCP server in Assistant settings",
      ],
    });
  }

  throw new RobloxAxiError({
    message: `${candidates.length} Studio instances match and selection is ambiguous`,
    code: "STUDIO_AMBIGUOUS",
    exitCode: ExitCode.StudioAmbiguous,
    suggestions: ["Run `roblox-studio-axi studios list`", "Retry with `--studio <id>`"],
    details: { studios: compact(candidates) },
  });
}
