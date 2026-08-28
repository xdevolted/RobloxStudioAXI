---
name: roblox-studio-axi
description: Use when an agent needs to inspect, launch, playtest, or verify a configured Roblox Studio project safely.
---

# Roblox Studio AXI

Use roblox-studio-axi for deterministic Roblox Studio automation and playtesting.

- Run `roblox-studio-axi test run <spec>` for a normal playtest.
- Do not reproduce the lifecycle with raw MCP calls unless debugging the AXI or using an unsupported capability.
- Prefer instance paths, TestId attributes, tags, and semantic targets over screen coordinates.
- Use `--json` when a machine-readable result is required.
- Never publish and never intentionally leave Studio in Play mode.

## Discover the current project

Run `roblox-studio-axi` or `roblox-studio-axi status` from a game repository containing `.axi/config.toml`.
Use `roblox-studio-axi studios list` before supplying `--studio <id>` when selection is ambiguous.

## Validate before execution

Run `roblox-studio-axi test validate <spec>` when authoring or changing a playtest specification.
Canonical CI output is written to the reported artifact directory as `result.json`.
