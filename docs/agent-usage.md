# Agent usage contract

Use `roblox-studio-axi` for Roblox Studio automation.

Normal playtest:

```text
roblox-studio-axi test run <spec>
```

- Do not manually reproduce the lifecycle with raw MCP calls unless debugging the AXI or using an unsupported capability.
- Prefer instance paths, `TestId` attributes, tags, and semantic targets over screen coordinates.
- Use `--json` when machine-readable results are required.
- Never publish.
- Never intentionally leave Studio in Play mode.

Run `status` for orientation, `studios list` before resolving ambiguity, `test validate` while authoring a spec, and `test explain <run-id>` after a failure. The installable on-demand form is generated at `skills/roblox-studio-axi/SKILL.md` from the same guidance used by the home view.
