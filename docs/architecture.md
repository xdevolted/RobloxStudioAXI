# Architecture

The package is split around stable domain operations rather than raw protocol messages.

```text
CLI commands
    │
    ├── project/config + schema validation
    │
    └── test/workflow runner
            │
            ├── StudioService (domain operations)
            │       └── Studio MCP adapter + official TypeScript client
            │
            ├── Studio CLI adapter (launch / RunScript argument construction)
            │
            └── evidence writer (manifest, result, report, console, screenshots)
```

## Boundaries

- `src/project`: upward discovery, TOML loading, precedence, path resolution, YAML parsing, and JSON Schema validation.
- `src/studio/cli`: documented executable discovery, argument arrays, process launch, RunScript, and timeouts. It never simulates playtest input.
- `src/studio/mcp`: stdio transport, runtime tool discovery, and capability normalization.
- `src/studio/service.ts`: normalized operations such as `listStudios`, `startPlay`, `executeLuau`, and `captureScreen`.
- `src/targeting`: generic instance path, `TestId`, tag, semantic UI, and explicit coordinate resolution.
- `src/runner`: lifecycle, safe polling, step execution, assertions, workflow orchestration, interruption handling, and mandatory cleanup.
- `src/evidence`: atomic, schema-validated artifact persistence.
- `src/cli.ts`: goal-oriented commands, strict argument validation, TOON/JSON output, errors, and exit codes.

Game repositories own all identity and business behavior. No shared source checks a game name or knows what a shop, round, checkpoint, or inventory means.

## Lifecycle

`test run` validates before connecting, discovers capabilities, lists Studios, selects deterministically, captures the console baseline, establishes the requested mode, executes steps and nearby assertions, collects evidence, and stops play mode in `finally`. Artifact JSON is written after cleanup so the cleanup outcome is canonical.

Read-only discovery and polling may repeat. Navigation, keyboard, mouse, and arbitrary Luau mutations are executed once unless a future spec explicitly adds an idempotency policy.

## Studio selection

Selection order is explicit `--studio`, unique configured place ID, unique expected place name, then exactly one connected Studio. Zero candidates is unavailable; multiple remaining candidates is ambiguity (exit 4).

## Versioning

The CLI and every schema begin at `0.1.0` / schema version `1`. Schema version fields are mandatory so future migrations can reject or upgrade deliberately.
