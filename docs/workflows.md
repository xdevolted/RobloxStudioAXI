# Workflows

Workflows select and order game-owned playtest files. They do not duplicate gameplay steps.

```yaml
schema_version: 1
name: smoke

tests:
  include:
    - tests/playtests/baseline/**/*.yaml
  exclude: []

execution:
  fail_fast: true
  timeout_seconds: 180

evidence:
  screenshots: on_failure
  console: errors_and_warnings

cleanup:
  stop_playtest: true
```

Patterns are evaluated from the game repository root and sorted deterministically. Each test receives its own evidence directory. `fail_fast: false` continues after test failures, but every individual test still performs cleanup before the next begins.

Run `roblox-studio-axi workflow list --full` to see resolved test counts and include patterns. A workflow matching zero files is a validation failure, not an empty success.
