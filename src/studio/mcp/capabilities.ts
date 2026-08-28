import { ExitCode, RobloxAxiError } from "../../errors.js";
import type { McpToolDescriptor } from "./transport.js";

export const ToolName = {
  ListStudios: "list_roblox_studios",
  StudioState: "get_studio_state",
  StartStopPlay: "start_stop_play",
  ExecuteLuau: "execute_luau",
  ConsoleOutput: "get_console_output",
  ScreenCapture: "screen_capture",
  CharacterNavigation: "character_navigation",
  KeyboardInput: "user_keyboard_input",
  MouseInput: "user_mouse_input",
} as const;

export type KnownToolName = (typeof ToolName)[keyof typeof ToolName];

export interface NormalizedCapabilities {
  available: string[];
  supported: Record<KnownToolName, boolean>;
}

export function normalizeCapabilities(tools: McpToolDescriptor[]): NormalizedCapabilities {
  const available = [...new Set(tools.map((tool) => tool.name))].sort();
  const names = new Set(available);
  return {
    available,
    supported: {
      [ToolName.ListStudios]: names.has(ToolName.ListStudios),
      [ToolName.StudioState]: names.has(ToolName.StudioState),
      [ToolName.StartStopPlay]: names.has(ToolName.StartStopPlay),
      [ToolName.ExecuteLuau]: names.has(ToolName.ExecuteLuau),
      [ToolName.ConsoleOutput]: names.has(ToolName.ConsoleOutput),
      [ToolName.ScreenCapture]: names.has(ToolName.ScreenCapture),
      [ToolName.CharacterNavigation]: names.has(ToolName.CharacterNavigation),
      [ToolName.KeyboardInput]: names.has(ToolName.KeyboardInput),
      [ToolName.MouseInput]: names.has(ToolName.MouseInput),
    },
  };
}

export function requireCapabilities(
  capabilities: NormalizedCapabilities,
  required: readonly KnownToolName[],
): void {
  const missing = required.filter((name) => !capabilities.supported[name]);
  if (missing.length === 0) return;
  throw new RobloxAxiError({
    message: `Studio MCP is missing required capabilities: ${missing.join(", ")}`,
    code: "MCP_CAPABILITY_MISSING",
    exitCode: ExitCode.McpFailure,
    suggestions: ["Update Roblox Studio", "Run `roblox-studio-axi status --full`"],
    details: { missing, available: capabilities.available },
  });
}
