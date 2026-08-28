export const AGENT_GUIDANCE = {
  description: "Use roblox-studio-axi for deterministic Roblox Studio automation and playtesting.",
  rules: [
    "Run `roblox-studio-axi test run <spec>` for a normal playtest.",
    "Do not reproduce the lifecycle with raw MCP calls unless debugging the AXI or using an unsupported capability.",
    "Prefer instance paths, TestId attributes, tags, and semantic targets over screen coordinates.",
    "Use `--json` when a machine-readable result is required.",
    "Never publish and never intentionally leave Studio in Play mode.",
  ],
} as const;

export const SKILL_DESCRIPTION =
  "Use when an agent needs to inspect, launch, playtest, or verify a configured Roblox Studio project safely.";
