# Local Multiplayer Session prototype evidence

Evidence for [Prove deterministic Local Multiplayer Session control](https://github.com/xdevolted/RobloxStudioAXI/issues/2), captured on 2026-08-31 with the throwaway prototype in [`prototypes/local-multiplayer-session`](../../prototypes/local-multiplayer-session/README.md).

## Verdict

The supported control and observation joins work on installed Roblox Studio `0.736.0.7361346`:

- documented CLI `RunScript` can call the `PluginSecurity`-tagged `StudioTestService:ExecuteMultiplayerTestAsync()`;
- the yielding `RunScript` process remains alive and supervised until server-side `EndTest()` completes;
- a random ownership token passed in the test arguments is readable from the Local Server and each Player Client through MCP;
- MCP can target every spawned DataModel independently;
- the Local Server can prove the exact joined-player count;
- an independent invocation refuses the live simulation before launch or mutation;
- server-side `EndTest()` gracefully tears down the Local Server, Player Clients, MCP targets, and bootstrap process.

This validates the selected control surface. It does not validate a durable Managed Session Record, recovery design, or production architecture.

## Scenario

- Configured local test project: `steal-a-varity`
- Requested Player Clients: `2`
- Prototype ownership token: `6b09065e-8f7d-426d-9d60-1fae16076a0e`
- Baseline edit process: PID `20280`
- Baseline MCP Studio ID: `8617371e-5c74-4b03-b40b-2fa80c184495`
- Start requested: `2026-08-31T07:48:50.646Z`
- Ready: `2026-08-31T07:49:09.883Z`
- Unmanaged competing invocation refused: `2026-08-31T07:49:10.651Z`
- Stop requested: `2026-08-31T07:49:11.281Z`
- Full teardown observed: `2026-08-31T07:49:14.619Z`

The prototype launched only documented arguments:

```text
--task RunScript
--localPlaceFile <configured absolute local place>
--runScriptFile <temporary bootstrap.luau>
--outputFile <temporary bootstrap-output.log>
--quitAfterExecution
```

The bootstrap called:

```lua
StudioTestService:ExecuteMultiplayerTestAsync(2, {
    protocol = "roblox-studio-axi/local-multiplayer-prototype/v1",
    session_id = "6b09065e-8f7d-426d-9d60-1fae16076a0e",
    requested_clients = 2,
    project = "steal-a-varity",
})
```

## Observed topology

```text
bootstrap/edit PID 18500, MCP 3b18ce4b-6ed3-4146-a90d-356a6eff65ee
└── Local Server PID 34988, MCP b9b4a432-59c1-4276-814d-e4f674c120ec
    ├── Player Client PID 23720, MCP dc7fd465-147a-4c6f-b360-6e28b34f5930
    └── Player Client PID 36112, MCP cae640f3-c80a-4e8c-aaae-88c668f3293f
```

The Windows process roles were inferred only for corroboration from the installed build's observed internal command lines. Control did not generate or depend on those internal arguments.

## Readiness evidence

The readiness poll observed the topology progressively rather than sleeping for a fixed duration:

1. Bootstrap process appeared.
2. Local Server process appeared.
3. Local Server MCP target appeared and returned the exact ownership token with `0` joined players.
4. Two Player Client processes appeared; the Local Server reported `1`, then `2` joined players.
5. Each Player Client appeared as a distinct MCP target, returned the exact ownership token, reported `RunService:IsClient() == true`, `game:IsLoaded() == true`, and a non-nil `Players.LocalPlayer`.

The accepted ready state was:

```json
{
  "processTopology": true,
  "datamodelTopology": true,
  "joined": true,
  "responsiveClients": 2,
  "fullyResponsive": true
}
```

This reached the strongest proposed `responsive` readiness level without human inference.

## Retry and stop evidence

- While the prototype-controlled session was live, a separate prototype process observed the Local Server / Player Client processes and refused before launch with `mutation: false`. The Local Multiplayer Session remained unchanged.
- A second start request for `2` clients re-probed ownership/readiness and returned `successful no-op` with `mutation: false`.
- A start request for `3` clients returned `conflict` with `mutation: false` while preserving the two-client session.
- Stop re-read `StudioTestService:GetTestArgs()` inside the exact Local Server and compared the session token before calling `EndTest()`.
- The bootstrap `ExecuteMultiplayerTestAsync()` returned, printed its completion marker, and exited with code `0`.
- A repeated stop after teardown returned `already stopped (no-op)` without mutation.
- Independent post-run checks found only the baseline edit PID and baseline MCP Studio ID. No prototype temporary directory remained.

## Limits exposed by the prototype

- The prototype's retry classification is in-memory. A production command needs the separate durable Managed Session Record decision before cross-process retries are safe.
- `--outputFile` contained bootstrap and completion markers after the yielding call returned; this run did not prove that it flushes a readiness marker while the call is still active. MCP ownership/readiness probes were sufficient, so the output file should not be the primary live signal.
- Windows role classification used version-specific internal command-line observations as corroboration. Production control must continue to use documented `StudioTestService`, and ownership must continue to come from the in-engine token.
- The prototype did not prove crash recovery, Windows job-object inheritance, stale-record handling, timeouts under partial startup, or behavior across Studio upgrades.
- The throwaway code deliberately leaves ambiguous failure cleanup to a guarded operator rather than embedding a production recovery policy.

## Human-in-the-loop acceptance

After the live demonstration and machine-observed teardown, the user instructed Wayfinder to continue the sub-issue and close it if finished. Every acceptance condition was independently observed through MCP and Windows process state, including the original edit process surviving teardown, so no separate visual-only claim is recorded or required for the verdict.
