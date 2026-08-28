# Playtest specification

Playtests are versioned YAML in the game repository. Version 0.1 deliberately keeps the DSL small.

```yaml
schema_version: 1
id: player-spawn
title: Player enters a clean play session

setup:
  mode: play
  timeout_seconds: 60

steps:
  - action: wait_for_player
    id: player_ready
    timeout_seconds: 20

  - action: capture
    id: spawned_capture
    label: spawned

assertions:
  - id: no_startup_errors
    type: console_errors
    maximum: 0
    after_step: spawned_capture

cleanup:
  stop_playtest: true
```

Validate with `roblox-studio-axi test validate <spec>`.

## Steps

- `wait` with `duration_ms`.
- `wait_for_state` (`edit`, `play`, or `paused`).
- `wait_for_player`.
- `start_play` and `stop_play` (idempotent).
- `execute_luau` with explicit `context` (`edit`, `client`, `server`) and exactly one of `code` or `file`.
- `navigate` with `[x, y, z]` or a semantic target.
- `keyboard` / `mouse` with the ordered Roblox MCP action objects.
- `capture` with a filesystem-safe label.
- `console_capture`.

Step IDs store results. Assertions reference a step as `actual: step_id` or a nested field as `actual: step_id.field` (the optional `steps.` prefix is accepted).

## Targets

Supply exactly one selector:

```yaml
target: { instance_path: "game.Workspace.Goal" }
target: { test_id: "stable-button-id" }
target: { tag: "PlaytestTarget" }
target: { semantic: "Start" }
target: { coordinates: { x: 640, y: 360 } }
```

Resolution order belongs in the spec, not in shared game logic. `test_id` means a generic Roblox `TestId` attribute. Coordinates are an explicit mouse fallback and are not valid for character navigation.

## Assertions

- `console_errors` with `maximum`.
- `equals`, `not_equals`, `truthy`, `falsy`, `exists`, `not_exists`.
- `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`.
- `numeric_delta` with step references, expected delta, and optional tolerance.
- `probe` with explicit context, Luau code/file, comparison operator, and optional expected value.

`after_step` evaluates close to the relevant action. Assertions without it run after all steps. Game-specific Luau belongs beside the game's tests, never in shared AXI source.
