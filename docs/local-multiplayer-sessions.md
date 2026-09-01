# Managed Local Multiplayer Sessions

Roblox Studio AXI manages one Windows-user-local multiplayer session containing one Local Server and an explicit number of Player Clients. The lifecycle uses the documented Studio `RunScript` task and `StudioTestService`; it does not synthesize Roblox's internal server/client arguments.

## Commands

```powershell
roblox-studio-axi session start --clients 2
roblox-studio-axi session status
roblox-studio-axi session stop
```

`session start` accepts `1..8` Player Clients. A same-project, same-target, same-count retry re-observes the existing session and succeeds without launching another bootstrap. A different project, target, or count conflicts until the active session is explicitly stopped.

All commands accept `--timeout <seconds>`, `--json`, `--full`, and `--verbose`. `--project <path>` scopes start and may assert the expected project during status or stop. Session commands intentionally expose no Studio selector, force, adoption, process-kill, or recovery-bypass flag.

## Ownership and recovery

The active record is stored at:

```text
%LOCALAPPDATA%\roblox-studio-axi\sessions\v1\active.json
```

It is a durable claim, not cleanup authority. Status or stop treats a live session as managed only when exactly one Local Server returns the complete matching protocol, session ID, canonical project identity, launch target, and requested client count through `StudioTestService:GetTestArgs()`.

Mutating commands serialize through a sibling transaction-lock directory. Lock ownership and Windows process ownership both pair PID with creation time so PID reuse cannot silently transfer authority. An abandoned lock owner must remain absent across repeated checks for one second within the five-second acquisition budget; a stale Managed Session Record is cleared only after repeated stable absence observations across ten seconds.

If ownership is missing, mismatched, unreachable, or ambiguous, AXI preserves the record and Studio state. Inspect with `session status --full`; when Studio visibly contains the session, use Studio's manual End Session control and re-run status.

## Readiness

The response separates state, ownership, readiness, and health. Readiness progresses through:

```text
none → bootstrap → process_topology → datamodel_topology → server_responsive → joined → responsive
```

`joined` is the minimum successful start level. It requires exact ownership, one Local Server, the requested process and MCP/DataModel topology, a responsive server, and the exact joined-player count. `responsive` additionally proves every Player Client is loaded and has a `LocalPlayer`. Counts AXI cannot independently observe are omitted rather than reported as zero.

## Evidence

Every start and stop attempt creates:

```text
%LOCALAPPDATA%\roblox-studio-axi\sessions\v1\evidence\<operation-id>\
├── manifest.json
├── observations.jsonl
├── actions.jsonl
├── bootstrap.luau       # starts only when launch is attempted
├── bootstrap.sha256     # starts only when launch is attempted
├── bootstrap.log        # starts only when launch is attempted
└── result.json           # written atomically last
```

A directory without `result.json` records a crash or interruption rather than a completed operation. `session status` is read-only and writes no operation evidence.

## Generic play safety

Ordinary `stop`, playtest setup/cleanup, workflow cleanup, and interruption cleanup share one guarded play-control seam. Any Managed Session Record, plausible multiplayer topology, or ambiguous observation blocks generic mutation. Only `session stop`, after a fresh exact Local Server ownership proof, can request `StudioTestService:EndTest()`.
