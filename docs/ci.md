# CI

Use a self-hosted Windows runner with Roblox Studio installed, signed in as an isolated test account, MCP enabled, and a non-production test place or local built place.

```powershell
npm ci
npm run check
roblox-studio-axi test run tests/playtests/baseline/smoke.yaml --json
```

Gate on both the process exit code and the run's canonical `result.json`. Preserve `.artifacts/playtests` as a CI artifact on success and failure.

The command is non-interactive. Multiple Studio candidates fail with exit 4. Timeouts fail with exit 6. Cleanup failure is its own exit 8 and must block the job.

Normal `npm test` uses fake MCP transport only and does not require Studio. Real-Studio tests belong in a separately invoked, opt-in job on the self-hosted runner.

Do not run this AXI on a production environment or enable live datastores. Do not add publishing credentials: version 0.1 has no publishing command.
