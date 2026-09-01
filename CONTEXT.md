# Roblox Studio AXI

Roblox Studio AXI provides deterministic, agent-oriented control of configured Roblox Studio projects while keeping game-specific behavior in each game repository.

## Language

**Local Multiplayer Session**:
A Roblox Studio test session containing one Local Server and a requested number of Player Clients for one configured game project.
_Avoid_: Server-and-clients workflow, multiplayer workflow

**Managed Local Multiplayer Session**:
A Local Multiplayer Session for which AXI holds a durable local claim that matches the identity exposed by its Local Server.
_Avoid_: AXI-owned session, owned session

**Managed Session Record**:
The user-local durable claim that identifies the one Local Multiplayer Session AXI may recover or clean up.
_Avoid_: Lease, session file, lock

**Session State**:
The primary classification of the Managed Local Multiplayer Session observed by a session command, independent of what that command attempted.
_Avoid_: Command result, play state

**Readiness Level**:
The strongest independently verified evidence that a Managed Local Multiplayer Session has reached an expected stage of startup and participation.
_Avoid_: Ready boolean, health

**Session Health**:
Whether the expected managed topology remains intact and non-contradictory, independent of the strongest Readiness Level achieved.
_Avoid_: Readiness, command success

**Session Command Result**:
The classified outcome of one `session start`, `session status`, or `session stop` invocation.
_Avoid_: Session State, exit code

**Session Operation Evidence**:
The durable user-local observation record written for a mutating session-command attempt, including no-op and unsuccessful attempts.
_Avoid_: Managed Session Record, playtest evidence

**Unmanaged Studio State**:
An active Studio simulation without both a matching Managed Session Record and matching Local Server identity.
_Avoid_: Foreign session, unknown play mode

**Local Server**:
The authoritative Roblox Studio server context within a Local Multiplayer Session.
_Avoid_: MCP server, Studio server

**Player Client**:
One simulated player context connected to the Local Server within a Local Multiplayer Session.
_Avoid_: MCP client, client when the meaning is ambiguous

**Built-in Operation**:
Game-agnostic automation shipped with Roblox Studio AXI and available from every configured game repository.
_Avoid_: Global workflow
