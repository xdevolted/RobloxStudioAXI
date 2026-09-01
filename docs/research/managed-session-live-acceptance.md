# Managed Local Multiplayer Session live acceptance

Evidence for [Live-verify managed Local Multiplayer Session lifecycle](https://github.com/xdevolted/RobloxStudioAXI/issues/8), captured on 2026-08-31 from commit `35c24b1` on `codex/deterministic-multiplayer-workflow`.

## Verdict

The production `session start`, `session status`, and `session stop` lifecycle passed its live Windows Studio acceptance run from the configured `steal-a-varity` repository.

- A two-client start reached `responsive` with exact Local Server ownership, one Local Server process and DataModel, two Player Client processes and DataModels, two joined players, and two responsive Player Clients.
- Status reproduced the same healthy topology without writing operation evidence.
- Same-count start was a successful no-op. Different client count and project requests returned conflict with exit `9` and did not change the running session.
- Removing the record from view temporarily caused production start to classify the live topology as unmanaged and refuse it. Restoring the record byte-for-byte restored management without adoption.
- Generic targeted play cleanup was blocked. Normal and degraded cleanup proceeded only through `session stop` after exact Local Server ownership proof.
- A synthetic stale record was reported read-only by status, then cleared by stop only after stable absence proof.
- Terminating the CLI caller after `bootstrap_started` left an incomplete operation, recovered first as transiently ambiguous and then as a proved but degraded starting session, and was cleaned up through guarded `EndTest()`.
- Repeated stop was a successful no-op.
- The pre-existing Edit Studio survived both sessions and remained in Edit mode after all cleanup.

The automated baseline also passed: 13 Vitest files / 72 tests and 6 setup tests.

## Environment

- Windows interactive user: current acceptance host
- Roblox Studio: `0.736.0.7361346`
- Roblox Studio AXI: `0.1.0`, globally linked to this checkout
- Configured project: `C:\Users\Savior\Documents\ROBLOX\Projects\steal-a-varity`
- Alternate conflict project: `C:\Users\Savior\Documents\ROBLOX\Projects\roblox-graybox`
- Baseline Edit Studio: MCP ID `2c5e41f2-4fd3-44ea-b6f7-67867188c659`, PID `5248`

## Healthy lifecycle

Managed session `72ea95a9-842e-4a39-af49-6af64770d479` launched two Player Clients. The final start and status observations both reported:

```text
state=running
ownership=proved
readiness=responsive
health=healthy
processes=2
datamodels=2
joined=2
responsive=2
```

The corroborating Windows topology contained bootstrap PID `24284`, Local Server PID `28856`, and Player Client PIDs `13224` and `26548`. The baseline Edit Studio PID `5248` remained separate throughout.

Canonical operation evidence lives under `%LOCALAPPDATA%\roblox-studio-axi\sessions\v1\evidence`:

| Operation | Result | Exit | Evidence ID |
| --- | --- | ---: | --- |
| Two-client start | `started` | 0 | `792c5632-74bd-4678-b367-ff4312dcb008` |
| Same-count retry | `already_running` | 0 | `9e5aa161-0337-4e48-8dc7-6522e573e43c` |
| Three-client conflict | `conflict` / `client_count_mismatch` | 9 | `15dfa93b-3194-46af-9dfc-b18db1b506b9` |
| Alternate-project conflict | `conflict` / `project_mismatch` | 9 | `392aca72-5e9c-4a52-a7dc-86bd16a3c0b6` |
| Recordless live-topology refusal | `conflict` / `unmanaged_studio_state` | 9 | `ccaa1584-bb8c-4de5-bc72-64a2f810c321` |
| Token-guarded normal stop | `stopped` | 0 | `0f07170d-35a7-4d50-bb6e-39072f3e620e` |
| Repeated stop | `already_stopped` | 0 | `c8cc060f-8c1d-487c-a03a-c7b14571a140` |
| Stable stale-record cleanup | `stale_record_cleared` | 0 | `9eb25a19-876d-4437-b12d-3330b9dfd363` |

The recordless check moved only `active.json` to a validated sibling path inside the session directory, preserved an exact backup, and restored the original SHA-256 `FB200F0BD43D20A1516A4E5E478485BFB616D7E7AD0132FBA110B31AB7D44272` in a `finally` block. The later stale-record check copied that exact record only after verified teardown. Its temporary fixture was removed after the stale record was safely cleared.

## Interrupted and degraded lifecycle

A hidden Node helper began a four-client production start. After its record and `bootstrap_started` action were durable, the exact helper PID `29772` and command line were verified and only that caller was terminated. No Studio process was killed.

The interrupted start operation `39d3719a-2d81-4621-96ce-263eb42cd4a4` intentionally has a manifest, observations, actions, bootstrap source/hash, and bootstrap log but no `result.json`. This is the canonical crash/interruption marker.

The first post-interruption status observed a changing MCP target set and returned `recovery_required` with ambiguous ownership, without mutation. A stable observation three seconds later reported managed session `d7ac81c4-da41-42fa-95ea-3adbba8351d4` as:

```text
state=starting
ownership=proved
readiness=server_responsive
health=degraded
client processes=4
client datamodels=0
joined players=1
```

`session stop` then re-proved the Local Server token, requested `EndTest()`, verified teardown, and removed the record. Its completed evidence is `ef63e091-5104-4042-8413-b052ebd8e48a`.

## Artifact checks

Every completed start/stop attempt above has a manifest-first directory and an atomically written `result.json` containing the structured response, semantic exit, start/finish timestamps, and duration. Only launch attempts contain the exact bootstrap source and SHA-256. The deliberately terminated start is the sole acceptance operation without `result.json`. Status remained read-only and created no operation directory.

The bootstrap log can continue changing after a successful start result while `ExecuteMultiplayerTestAsync()` remains active; `result.json` is the command-completion marker, not a promise that every supervised file has an older filesystem timestamp.

## Limits and unproved crash modes

- This run killed a verified CLI caller, not the machine, Windows user session, bootstrap Studio process, Local Server, or Roblox Studio installation. Power loss and those process-crash modes remain unproved live.
- Persistent MCP loss, a contradictory ownership tuple, or ambiguous process inspection were not forced. The supported response remains fail-closed status plus manual Studio End Session when ownership cannot be re-proved.
- Recordless and stale-record recovery used reversible synthetic record placement around independently verified live/absent topology. They validate the production classifiers and mutations without claiming an organic disk-loss event occurred.
- Studio upgrade compatibility beyond `0.736.0.7361346` remains unproved.
- No process-kill, ownership bypass, force/adopt path, publishing, production target, or live datastore operation was used.

The final observation reported managed state `absent`; only the original MCP ID `2c5e41f2-4fd3-44ea-b6f7-67867188c659` and Studio PID `5248` remained, with play state `edit`.
