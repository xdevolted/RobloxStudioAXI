# Troubleshooting

## Setup is incomplete

From the RobloxStudioAXI checkout, inspect the CLI and user-level skill links without changing
them:

```powershell
node scripts/setup.mjs --check
```

Run `node scripts/setup.mjs` to install or repair both links. Use
`node scripts/setup.mjs --help` when only the CLI
or only the skill should be managed. If setup reports that the skill target is a real directory,
move that directory aside first; setup never overwrites an existing directory.

If the CLI link fails on macOS or Linux, check the permissions and PATH for the npm global prefix.
If Codex was already open when the skill link was created, restart Codex so the skill list refreshes.

Start with:

```powershell
roblox-studio-axi status --full --verbose
roblox-studio-axi studios list --full
```

## MCP unavailable

In Studio, open Assistant, choose Manage MCP Servers, and enable Studio as an MCP server. Restart Studio after an update and verify the quick-connect instructions.

On Windows the documented stdio entrypoint is:

```text
cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat
```

If `mcp.bat` or the Roblox Studio registry entry still targets an older removed version, update/restart Studio so Roblox repairs its launcher. The AXI deliberately does not search for and execute an undocumented Windows `StudioMCP.exe` fallback.

## Zero connected Studios

The MCP process can start successfully while listing zero instances. Confirm the intended Studio window is open and MCP is enabled. `test run` may launch the configured local or published place, then waits up to `studio.startup_timeout_seconds` for it to connect.

## Ambiguous Studio

Run `studios list`, inspect IDs/names/place IDs, then retry with `--studio <id>`. The AXI never chooses an arbitrary window.

## Missing capability

The CLI discovers tools on every connection. Update Studio when a required tool such as `screen_capture` is missing. Roblox's documentation describes a `playtest` subagent, while some Studio builds expose other subagent types; version 0.1 does not depend on any subagent and uses deterministic tools directly.

## Local place missing

Build the file configured as `project.local_place` before invoking a command that needs to launch Studio. For Rojo projects this is normally the repository's existing build command.

## Explain a failed run

```powershell
roblox-studio-axi test explain <run-id>
roblox-studio-axi test explain <run-id> --full
```

Inspect `result.json`, `console.log`, screenshots, and cleanup status. Protocol diagnostics go to stderr only with `--verbose`; structured errors remain on stdout.
