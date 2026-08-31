# Local Multiplayer Session control prototype

> **THROWAWAY PROTOTYPE.** This answers the control/readiness question in [Prove deterministic Local Multiplayer Session control](https://github.com/xdevolted/RobloxStudioAXI/issues/2). It is not production architecture and should not be merged into the product.

The prototype uses only the selected supported control path:

- documented Studio CLI `RunScript` bootstrap;
- `StudioTestService:ExecuteMultiplayerTestAsync(1..8, ownershipArgs)`;
- Studio MCP for exact server/client probes and server-side `EndTest()`;
- Windows process topology as corroborating evidence.

Build the repository, ensure the configured test project has no active Studio simulation, then run:

```powershell
npm run build
node prototypes/local-multiplayer-session/probe.mjs --project C:\path\to\configured-game-repository --clients 2
```

The command prints the complete observed state after each transition. It refuses to start beside any observed Local Server or Player Client process. If it fails after launch, it deliberately does not kill ambiguous Studio processes; use the emitted ownership token and process/MCP evidence for guarded cleanup.
