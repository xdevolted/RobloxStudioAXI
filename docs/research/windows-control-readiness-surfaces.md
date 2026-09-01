# Windows control and readiness surfaces for Local Multiplayer Sessions

Research for [Determine Windows control and readiness surfaces](https://github.com/xdevolted/RobloxStudioAXI/issues/3), captured 2026-08-31. This note combines official documentation, repository source/tests, and a snapshot of an already-running Local Multiplayer Session. It did not launch, invoke a playtest action, type into, or stop Roblox Studio. One guarded UI Automation probe expanded the semantic Test menu, inspected accessibility state, collapsed it again, and verified restoration.

## Answer

Use Roblox's documented `StudioTestService` as the primary Local Multiplayer Session control surface, with the documented Studio `RunScript` task as the bootstrap candidate and Studio MCP as the observation and server-side command channel. Do not synthesize Roblox's observed internal `StartServer` / `StartClient` command lines.

The proposed order is:

1. **Control:** start through `StudioTestService:ExecuteMultiplayerTestAsync(clients, ownershipArgs)`. It is the only currently documented surface found that accepts an explicit Player Client count and launches one Local Server plus that many Player Client DataModels. Its documented range is 1–8, and it rejects a second running test. [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService/ExecuteMultiplayerTestAsync)
2. **Bootstrap:** prototype invoking that method from a documented `RobloxStudioBeta.exe --task RunScript ...` process. `RunScript` runs after the place loads at Studio command-bar permission and can target a local or published place. [`Studio command-line interface`](https://create.roblox.com/docs/studio/command-line-interface)
3. **Ownership:** put a cryptographically random AXI session ID and protocol version in the `args` passed to `ExecuteMultiplayerTestAsync`; confirm it from the Local Server through `StudioTestService:GetTestArgs()` before status or stop treats the session as owned. Roblox documents that the argument is forwarded into the test and that server-side `GetTestArgs()` works. [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService/GetTestArgs)
4. **Readiness:** require both OS topology and in-engine evidence: exactly one observed Local Server process, exactly the requested Player Client process count, MCP play/DataModel state, a responsive Local Server Luau probe, and `#Players:GetPlayers() == clients`. A `Player` represents a currently connected client, and `Players:GetPlayers()` is the supported way to enumerate them. [`Player`](https://create.roblox.com/docs/reference/engine/classes/Player), [`Players`](https://create.roblox.com/docs/reference/engine/classes/Players/GetPlayers)
5. **Stop:** after ownership is re-proved on the exact Local Server target, call `StudioTestService:EndTest(result)` in the Server DataModel. Roblox documents that this ends the current test even if the service did not start it, is server-only during a running test, and completes asynchronously. Then wait for all topology and MCP state to disappear and for the owned bootstrap process to finish. [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService/EndTest)

This is a recommendation, not yet a live proof. The next ticket should prototype the two uncertain joins: whether CLI `RunScript` can call the `PluginSecurity`-tagged `ExecuteMultiplayerTestAsync` on the installed build, and exactly how Studio MCP enumerates and targets the resulting edit, Local Server, and multiple Player Client processes.

Because `ExecuteMultiplayerTestAsync` yields until the test ends, `session start` cannot await the repository's current synchronous `runScript()` process collector. It needs a detached but supervised bootstrap plus out-of-band ownership and readiness signals.

## Confirmed facts

### Roblox Studio CLI

- Roblox documents Windows Studio at `%LOCALAPPDATA%\Roblox\Versions\[version]\RobloxStudioBeta.exe`; documented place-open tasks are `EditPlace`, `EditPlaceRevision`, and `EditFile`. [`Studio command-line interface`](https://create.roblox.com/docs/studio/command-line-interface)
- `--task RunScript --runScriptFile <absolute path>` runs Luau after the place loads at Studio command-bar permission. It accepts `--localPlaceFile` or the `--placeId` / `--universeId` pair, optional `--outputFile`, and optional `--quitAfterExecution`. [`Studio command-line interface`](https://create.roblox.com/docs/studio/command-line-interface)
- The official CLI page documents no Local Server / Player Client launch task and no Player Client count flag. It explicitly says undocumented arguments are internal and subject to change without notice. [`Studio command-line interface`](https://create.roblox.com/docs/studio/command-line-interface)
- The repository already constructs only these documented argument sets in [`src/studio/cli/args.ts`](../../src/studio/cli/args.ts) and launches them through [`src/studio/cli/process.ts`](../../src/studio/cli/process.ts). This seam can host a bootstrap process without adopting internal flags.

### `StudioTestService`

- Roblox's testing guide now identifies `StudioTestService` as a Studio-only, programmatic multi-client simulation surface usable from a plugin or build pipeline: it can start a Local Server with up to eight Player Clients, add players, pass test arguments, trigger client disconnects, and end from the Local Server. [`Studio testing modes`](https://create.roblox.com/docs/studio/testing-modes#scripted-testing)
- `ExecuteMultiplayerTestAsync(numPlayers, args)` yields, creates one Local Server and `numPlayers` Player Client DataModels, supports 1–8 Player Clients, and errors if a test is already running or if the count is outside that range. The method is tagged `PluginSecurity`. [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService/ExecuteMultiplayerTestAsync)
- Version one can therefore validate a static supported range of `1..8`; it should not scrape a version-dependent UI limit or infer one from the installed binary. Runtime capability discovery plus the method's structured failure remains the compatibility check for a future Studio build.
- `AddPlayers()` must run in the Local Server DataModel of an active multiplayer test. `EndTest()` must run in the Local Server DataModel; it ends asynchronously. `CanLeaveTest()` / `LeaveTest()` are Player Client-side controls for deliberate disconnect testing, not whole-session cleanup. [`StudioTestService`](https://create.roblox.com/docs/reference/engine/classes/StudioTestService)
- Roblox Studio's interactive multi-client simulation has the same 1–8 ceiling, starts with F7 after choosing a count, and its End Session action from any simulation window closes the Local Server and all Player Clients. [`Studio testing modes`](https://create.roblox.com/docs/studio/testing-modes#multi-client-simulation)
- The older `TestService.NumberOfPlayers` surface is documented to open `N + 1` Studio windows when Studio runs the test, but `TestService:Run()` is deprecated. It corroborates the expected one-server-plus-N-clients topology; it is not preferred over the purpose-built `StudioTestService`. [`TestService`](https://create.roblox.com/docs/reference/engine/classes/TestService)

### Studio MCP

- Studio MCP is built into Studio and runs as a local stdio process. The documented Windows launcher is `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`. [`Studio MCP`](https://create.roblox.com/docs/studio/mcp)
- The documented relevant tools are `list_roblox_studios`, `get_studio_state`, `start_stop_play`, `execute_luau`, `get_console_output`, and `screen_capture`. `get_studio_state` reports play state and available DataModel types; `execute_luau` requires an Edit, Client, or Server `datamodel_type`. [`Studio MCP`](https://create.roblox.com/docs/studio/mcp)
- `list_roblox_studios` returns Studio name, Studio instance ID, and place ID when one exists. Every tool call targets a `studio_id`; Roblox describes this explicit addressing as reliable across multiple Studio instances and agents. [`Studio MCP`](https://create.roblox.com/docs/studio/mcp#use-multiple-studio-instances)
- The documented MCP surface exposes no explicit Player Client count or Server & Clients mode argument. Consequently, generic `start_stop_play` alone cannot establish the requested topology or ownership. It can only be considered after the target session has independently been identified.
- The repository discovers capabilities at runtime and currently normalizes the same relevant tools in [`src/studio/mcp/capabilities.ts`](../../src/studio/mcp/capabilities.ts). Its [`StudioService`](../../src/studio/service.ts) normalizes mode and available DataModels, starts/stops generic play, and can execute a Server or Client probe. Existing fake-MCP tests prove the adapter behavior, not Local Multiplayer Session behavior; see [`test/integration/fake-mcp.test.ts`](../../test/integration/fake-mcp.test.ts).

### Windows observation surfaces

- `Win32_Process` exposes read-only `CommandLine`, `CreationDate`, `ParentProcessId`, and `ProcessId`. Microsoft warns that process IDs and parent process IDs are reused, so a PID must be paired with creation time and revalidated. [`Win32_Process`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
- A top-level HWND can be mapped to its creating process with `GetWindowThreadProcessId`. [`GetWindowThreadProcessId`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)
- Windows UI Automation exposes UI elements as a tree with properties and supported control patterns. Buttons may support `Invoke`; menus may support `ExpandCollapse`; selection containers/items use `Selection` / `SelectionItem`; numeric controls can use `RangeValue` or `Value`. [`UI Automation control patterns`](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)
- UIA selectors are not a durable identity by themselves: `AutomationId` is optional, only sibling-unique, and not guaranteed stable across application releases; `Name` can be localized and is not unique. [`Using UI Automation for automated testing`](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting)
- Custom controls without a provider can be largely opaque to UIA. [`UI Automation providers`](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-providersoverview)
- Windows job objects can manage a process group, normally including descendant processes, and can report or terminate job membership. This is a possible supplemental ownership boundary only if a live proof shows Studio's Local Server and Player Clients remain in the job; abrupt job termination is recovery, not the normal stop path. [`Job Objects`](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## Read-only local observation (version-specific)

Installed Studio was `0.736.0.7361346` in version directory `version-268c7d941ba34c1a`. `%LOCALAPPDATA%\Roblox\mcp.bat` existed and delegated to that version's `StudioMCP.exe`, matching the documented MCP launcher shape.

An already-running two-Player-Client session had this Windows process topology:

```text
edit RobloxStudioBeta.exe
└── Local Server RobloxStudioBeta.exe
    ├── Player Client RobloxStudioBeta.exe
    └── Player Client RobloxStudioBeta.exe
```

All four were separate `RobloxStudioBeta.exe` processes with top-level windows. The Local Server was a child of the edit process and both Player Clients were children of the Local Server. The two Player Client window titles were identical (`Place1 - Roblox Studio`), so title matching cannot identify individual Player Clients or ownership.

Their command lines contained a shared `playTestSessionGuid`; the server identified itself as `StudioServer`, the clients as `StudioPlayer_0` / `StudioPlayer_1`, and the observed count was also present. These are useful corroborating observations only. The arguments (`StartServer`, `StartClient`, `playTestSessionGuid`, `instanceId`, `editpid`, and related fields) are absent from Roblox's public CLI documentation, whose warning makes them unsuitable as generated launch arguments or sole ownership proof.

A raw UIA walk found roughly 135–143 descendants per Studio window. It exposed the top-level `Test` menu as a `QAction` menu item with `Invoke`, `Value`, and `ExpandCollapse` patterns. However, the main ribbon was exposed as opaque `PluginPanelCustom` / `RBX::Studio::QEngineWidget` groups; the walk found no semantic `Server & Clients`, Player Client count, Play, or End Session element. This observation occurred while the session was already running, so it does not prove that a popup or edit-mode tree never exposes those items. It does prove that the current always-visible raw tree is insufficient for a count-setting UIA implementation.

## Facts versus inferences

| Topic | Fact | Inference / consequence |
| --- | --- | --- |
| Explicit count | `StudioTestService` accepts 1–8; MCP `start_stop_play` has no documented count. | Prefer `StudioTestService`; reject 0 or >8 before launching anything. |
| Bootstrap | CLI `RunScript` is documented and runs at command-bar permission; the multiplayer method is `PluginSecurity`. | Roblox's build-pipeline wording strongly suggests compatibility, but the exact permission join must be live-prototyped. |
| Ownership | `args` are forwarded and Local Server `GetTestArgs()` works. | A random AXI session ID inside `args` can be an in-engine ownership proof. This is stronger than titles, place name, PID, or play mode alone. |
| Topology | One observed Local Server process parented two Player Client processes; internal command lines shared a session GUID. | Parent/child topology plus a version-gated observed session GUID can corroborate the Managed Session Record, but neither should replace the ownership token. |
| Joined players | A `Player` represents a connected client; `Players:GetPlayers()` enumerates current players. | A successful Local Server probe with exact count proves joins, not merely process launch. |
| Responsiveness | MCP `execute_luau` can target Server or Client DataModels; `DataModel:IsLoaded()` reports whether initial instances have replicated to a Player Client. | A successful Server probe proves server responsiveness. Per-Player-Client responsiveness should require `game:IsLoaded()`, `Players.LocalPlayer`, and optionally character presence, but first requires discovering whether each spawned process has a distinct targetable `studio_id`. [`DataModel`](https://create.roblox.com/docs/reference/engine/classes/DataModel#IsLoaded), [`Players`](https://create.roblox.com/docs/reference/engine/classes/Players#LocalPlayer) |
| Stopping | Server-side `EndTest()` ends the entire current test asynchronously. | Only invoke it after token, target, and topology match; otherwise it could stop an unrelated test. |
| UIA | The Test menu is visible, but current ribbon contents are opaque and semantic session controls were absent. | UIA is not ready as the primary surface. A later prototype may enable a guarded fallback if popup controls become semantically discoverable. |

## Required readiness and stop checks

The command should report the strongest completed verification level, not collapse all evidence into `ready`:

1. `owned_process`: the Managed Session Record matches bootstrap PID **and creation time**, executable/version, project identity, and random session ID.
2. `topology`: one Local Server and exactly `n` Player Client processes/windows are descendants of that bootstrap, with no extra candidate. Internal session GUID/instance labels may corroborate only on a recognized Studio build.
3. `datamodels`: MCP has one unambiguous target with a Server DataModel and the expected Player Client targets/DataModels; every target is in a running state.
4. `joined`: a Local Server Luau probe returns `#Players:GetPlayers() == n` and the session ownership argument matches.
5. `responsive`: the Local Server probe succeeds and, if MCP exposes each Player Client independently, every Player Client reports `game:IsLoaded()`, returns its LocalPlayer identity, and optionally has a character; the identities match the Local Server's player set.

`session start` should succeed as ready only at level 4 at minimum. Level 5 is the desired independently observed proof. If per-Player-Client targeting is unavailable, say so explicitly rather than inferring responsiveness from process existence.

For `session stop`:

1. Re-read the Managed Session Record and revalidate PID creation times; never trust a stored PID alone.
2. Re-enumerate the process/window topology and MCP candidates.
3. Probe the exact Local Server and require the ownership argument to equal the Managed Session Record's random session ID.
4. Invoke Local Server `StudioTestService:EndTest()` once.
5. Poll until the Local Server and all Player Clients exit, MCP no longer reports their DataModels, and the owned `RunScript --quitAfterExecution` bootstrap exits.
6. A repeated stop with no Managed Session Record or matching live topology is a successful no-op; a mismatched or partially matching live topology is a conflict requiring intervention.

## Safe fallback boundary

The weakest safe fallback today is **fail closed**:

- Do not use internal Roblox CLI launch flags.
- Do not use fixed screen coordinates.
- Do not press F7 or Shift+F5 against whichever window happens to be focused.
- Do not call generic MCP `start_stop_play(false)` merely because a Studio is playing.
- Do not terminate a process tree unless a later ownership/recovery decision explicitly establishes a dedicated, revalidated AXI process group as disposable.

If the `StudioTestService` bootstrap or exact Local Server MCP targeting is unavailable, return a structured unsupported/ambiguous state and leave the session untouched, with manual cleanup guidance. A UIA fallback can graduate only after a live prototype demonstrates semantic, enabled controls for mode, count, start, and End Session on the installed version; it must scope lookup to the exact managed HWND/PID, require a unique match and expected pre-state, use supported UIA patterns rather than coordinates, and verify each mutation through independent topology/MCP probes.

## Questions for the proof ticket

1. Can documented CLI `RunScript` call `ExecuteMultiplayerTestAsync` on Studio `0.736` and remain alive/yielded until `EndTest`?
2. Does `--outputFile` flush a readiness/ownership marker before the yielding script returns, or is a separate IPC ownership signal required?
3. Which Studio processes appear in `list_roblox_studios`, and can each Local Server / Player Client be mapped unambiguously to a Windows PID and DataModel context?
4. Can MCP `execute_luau` in the Local Server read the bootstrap `GetTestArgs()` value and call `EndTest()`?
5. Can every Player Client be individually probed, or must process responsiveness be reported as a weaker verification level?
6. In edit mode, do the Test menu popup or any alternate accessibility view expose semantic Server & Clients, count, Play, and End Session controls?
