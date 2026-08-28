# Roblox Studio AXI

Roblox Studio AXI is a reusable, agent-oriented CLI for discovering a Roblox game project, connecting to the official Roblox Studio MCP server, selecting the correct open Studio deterministically, running a versioned playtest, collecting evidence, and returning Studio to Edit mode.

It is not a game framework, a publisher, a replacement for Rojo, or a bag of game-specific automation. Game identities, places, selectors, probes, workflows, and acceptance tests stay in each game repository.

Status: version `0.1.0` implements the end-to-end deterministic playtest spine and is unit/fake-MCP tested. Real-Studio tests are optional and never run from `npm test`.

## Install once, use from every Roblox project

- Git.
- Node.js 20 or newer (Node 24 LTS is supported).
- Roblox Studio with its built-in MCP server enabled.

Choose the parent directory where you want `RobloxStudioAXI` installed, change into that directory,
then clone and run setup from inside the new checkout:

```shell
cd path/to/your/chosen/directory
git clone https://github.com/xdevolted/RobloxStudioAXI.git
cd RobloxStudioAXI
node scripts/setup.mjs
```

Git creates the `RobloxStudioAXI` directory. The setup script does not create a `SharedLibraries`
parent directory or move the checkout. If you want that layout, create or choose `SharedLibraries`
first, change into it, and run the commands above.

`node scripts/setup.mjs` is non-interactive and idempotent. It:

1. installs the exact dependencies from `package-lock.json`;
2. builds, typechecks, tests, and verifies the generated skill;
3. links `roblox-studio-axi` into the npm global command path; and
4. links the included agent skill into the user-level `.agents/skills/roblox-studio-axi`
   directory.

Check an existing installation without changing it:

```shell
node scripts/setup.mjs --check
roblox-studio-axi --version
```

The setup result is compact and machine-readable. Progress and command diagnostics go to stderr.
Use `node scripts/setup.mjs --help` for the complete option list, including CLI-only or skill-only
installation.

### Let an agent discover it

The setup command registers the included `roblox-studio-axi` skill at the user scope, so Codex can
discover it from any game repository. Codex supports symlinked skill directories and scans
`~/.agents/skills`; see the [official Codex skill locations](https://developers.openai.com/codex/skills#where-codex-loads-local-skills).

If Codex was already open during setup, restart it if the skill does not appear. Then invoke it
explicitly with `$roblox-studio-axi`, select it from `/skills`, or ask naturally:

```text
Use Roblox Studio AXI to inspect this project and run its smoke playtest.
```

Agents that do not support the Agent Skills format can still call the installed
`roblox-studio-axi` command directly. Compatible agents can use the portable skill directory at
`skills/roblox-studio-axi/` according to their own skill-discovery rules.

No session hooks are installed. Setup only creates the explicit CLI and skill links described
above.

### CLI-only installation

If skill discovery is not needed, install the CLI directly from GitHub:

```shell
npm install --global git+https://github.com/xdevolted/RobloxStudioAXI.git
roblox-studio-axi --version
```

This path builds automatically during installation but does not register the agent skill. The
repository is currently private, so the GitHub account performing either clone must have access.

### Update or repair

From the shared-library checkout:

```shell
git pull --ff-only
node scripts/setup.mjs
node scripts/setup.mjs --check
```

Repeated setup repairs stale CLI or skill links and otherwise succeeds as a no-op.

## First command

Each game repository owns its `.axi/config.toml`, workflows, and playtest specifications. From a
configured game repository:

```powershell
roblox-studio-axi
```

The no-argument home view returns the executable identity, project, config, Studio connection count, deterministic selection, play state, test/workflow counts, and useful next commands. It reports an explicit disconnected state when no Studio is available.

## Commands

```text
roblox-studio-axi
roblox-studio-axi status
roblox-studio-axi studios list
roblox-studio-axi project inspect
roblox-studio-axi test validate <spec>
roblox-studio-axi test run <spec>
roblox-studio-axi test explain <result-or-run-id>
roblox-studio-axi workflow list
roblox-studio-axi workflow run <name>
roblox-studio-axi stop
roblox-studio-axi version
```

All flags follow the command. Common flags are:

```text
--project <path>  Explicit project root
--studio <id>     Explicit Studio selection
--json            Machine-readable stdout
--full            Expanded detail
--verbose         Diagnostics on stderr
```

Unknown flags and arguments fail before any Studio operation. Commands never prompt.

## Project discovery

The AXI searches upward from the current directory for `.axi/config.toml`. `--project <path>` overrides discovery. Resolved precedence is:

1. explicit CLI options;
2. project `.axi/config.toml`;
3. optional user config (`%APPDATA%\roblox-studio-axi\config.toml` on Windows or `~/.config/roblox-studio-axi/config.toml` elsewhere);
4. conservative defaults.

See [project configuration](docs/project-configuration.md).

## Run a test

```powershell
roblox-studio-axi test validate tests/playtests/baseline/smoke.yaml
roblox-studio-axi test run tests/playtests/baseline/smoke.yaml
roblox-studio-axi test run tests/playtests/baseline/smoke.yaml --json
```

One command performs capability discovery, Studio selection, baseline console capture, play startup, steps, assertions, screenshots/console evidence, mandatory cleanup, artifact persistence, and compact reporting. `result.json` is canonical for CI.

## Run a workflow

```powershell
roblox-studio-axi workflow list
roblox-studio-axi workflow run smoke --json
```

Workflows select ordered playtest specifications; they do not contain gameplay actions themselves. See [workflows](docs/workflows.md).

## Output and exits

Default stdout is TOON, generated by the maintained `axi-sdk-js@0.1.11` and `@toon-format/toon@4.1.1` packages. JSON artifacts remain normal JSON.

| Exit | Meaning |
| ---: | --- |
| 0 | passed or successful no-op |
| 1 | assertion/test failure |
| 2 | invalid usage, configuration, workflow, or test specification |
| 3 | Studio unavailable |
| 4 | Studio selection ambiguous |
| 5 | MCP connection or capability failure |
| 6 | timeout |
| 7 | AXI/internal failure or interruption |
| 8 | cleanup failure |

## Evidence

Every run receives a unique directory under the configured evidence root:

```text
.artifacts/playtests/<run-id>/
├── manifest.json
├── result.json
├── report.md
├── console.log
└── screenshots/
```

`manifest.json` records identity and a SHA-256 spec digest. `result.json` records assertions, timings, console counts, cleanup, failure information, and paths to binary evidence.

## Adopt from another game

A new project needs no shared-source change:

```text
NewGame/
├── .axi/
│   ├── config.toml
│   └── workflows/smoke.yaml
└── tests/playtests/baseline/smoke.yaml
```

Configure its own place and expected Studio identity, write generic steps/probes for its actual behavior, and invoke the stable executable.

The shared-library repository contains no game-specific place files, IDs, credentials, workflows,
or acceptance tests. See [project configuration](docs/project-configuration.md) and
[playtest specifications](docs/playtest-spec.md) when adding a game.

## Develop the shared library

Setup is for a persistent shared checkout. Contributors can run the verification path directly:

```shell
npm ci
npm run check
```

The `prepare` lifecycle builds distributable files for npm and direct Git installs. Generated
`dist/` files and local dependencies remain ignored because they are reproducible from the tracked
source and lockfile.

## Safety

- Publishing is not implemented and `allow_publish = true` is schema-invalid.
- Production and live-datastore playtests are refused before Studio is launched.
- Multiple Studio matches are never guessed; use `--studio <id>`.
- Play mode cleanup runs through a `finally` path after success, assertion failure, timeout, and interruption.
- Mutating inputs and arbitrary Luau are not blindly retried.

## Troubleshooting

Run `roblox-studio-axi status --full --verbose`, then see [troubleshooting](docs/troubleshooting.md). The CLI uses only Roblox-documented launch arguments and the documented MCP stdio entrypoint; it does not fall back to hidden Studio flags or an undocumented Windows MCP executable.

## References

- [Roblox Studio command-line interface](https://create.roblox.com/docs/studio/command-line-interface)
- [Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp)
- [AXI design principles](https://axi.md/)
- [TOON specification](https://toonformat.dev/reference/spec)

Additional documentation: [architecture](docs/architecture.md), [playtest specs](docs/playtest-spec.md), [CI](docs/ci.md), and [agent usage](docs/agent-usage.md).
