# Project configuration

Place `.axi/config.toml` in each game repository. Paths are resolved relative to that repository unless absolute.

```toml
schema_version = 1

[project]
name = "MyGame"
expected_place_name = "MyGame"
local_place = "build/MyGame.rbxlx"
# For a published edit target, configure both values instead:
# place_id = 123
# universe_id = 456

[studio]
startup_timeout_seconds = 60
operation_timeout_seconds = 30

[testing]
playtests = "tests/playtests"
workflows = ".axi/workflows"
default_workflow = "smoke"

[evidence]
directory = ".artifacts/playtests"
screenshots = "on_failure" # always | on_failure | never
console = "errors_and_warnings" # all | errors_and_warnings | errors

[safety]
environment = "test" # test | development | production
allow_publish = false
allow_live_datastores = false
always_stop_playtest = true
```

`project.name` is an identifier, not a folder-name constraint. `place_id` and `universe_id` must appear together. A local place takes launch precedence when both a local and published identity are present.

The optional user config supplies machine defaults. Project values win. CLI `--project` and `--studio` win over configuration.

Do not commit credentials. Version 0.1 requires no Roblox credentials and never publishes. User-local MCP command overrides may be placed in the optional user config when an organization wraps the documented launcher, but ordinary projects should use Roblox's platform default.

Production or live-datastore settings may be inspected with `status`, but `test run` and `workflow run` refuse them before process launch.
