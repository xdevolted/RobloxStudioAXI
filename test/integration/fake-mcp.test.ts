import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCallResult, McpToolDescriptor, McpTransport } from "../../src/studio/mcp/transport.js";
import { ToolName } from "../../src/studio/mcp/capabilities.js";
import { StudioService } from "../../src/studio/service.js";
import { runPlaytest } from "../../src/runner/test-runner.js";
import { runWorkflow } from "../../src/runner/workflow-runner.js";
import type { PlaytestSpec } from "../../src/types.js";
import { resolvedConfig } from "../helpers.js";

const allTools = Object.values(ToolName).map((name) => ({ name, inputSchema: {} }));
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class FakeTransport implements McpTransport {
  connected = false;
  closed = false;
  mode: "edit" | "play" = "edit";
  studios: Array<{ studio_id: string; name: string; place_id?: number }> = [
    { studio_id: "studio-1", name: "FixtureGame", place_id: 22 },
  ];
  tools: McpToolDescriptor[] = [...allTools];
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  consoleEntries: Array<Record<string, unknown>> = [];
  failStop = false;
  stateFormat: "json" | "text" = "json";

  async connect() {
    this.connected = true;
  }
  async listTools() {
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args });
    if (name === ToolName.ListStudios) return text({ studios: this.studios });
    if (name === ToolName.StudioState) {
      if (this.stateFormat === "text") {
        const mode = this.mode === "play" ? "Play" : "Edit";
        const dataModels = this.mode === "play" ? "Client, Server" : "Edit";
        return {
          content: [{
            type: "text",
            text: `- Current Studio Mode: ${mode}\n- Available DataModels: ${dataModels}\n- Focused DataModel in the viewport: ${this.mode === "play" ? "Client" : "Edit"}`,
          }],
          isError: false,
        };
      }
      return text({ play_state: this.mode === "play" ? "Playing" : "Edit", available_datamodel_types: this.mode === "play" ? ["Client", "Server"] : ["Edit"] });
    }
    if (name === ToolName.StartStopPlay) {
      if (args.is_start === false && this.failStop) {
        return { content: [{ type: "text", text: "stop failed" }], isError: true };
      }
      this.mode = args.is_start ? "play" : "edit";
      return text({ ok: true });
    }
    if (name === ToolName.ExecuteLuau) return text({ result: true });
    if (name === ToolName.ConsoleOutput) return text({ messages: this.consoleEntries });
    if (name === ToolName.ScreenCapture) {
      return { content: [{ type: "image", data: onePixelPng, mimeType: "image/png" }], isError: false };
    }
    return text({ ok: true });
  }
  async close() {
    this.closed = true;
  }
}

function text(value: unknown): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "roblox-axi-fake-"));
  temporary.push(root);
  const transport = new FakeTransport();
  const service = new StudioService(transport, 100);
  await service.connect();
  const config = resolvedConfig(root);
  const playControl = {
    start: (studioId: string) => service.startPlay(studioId),
    stop: (studioId: string) => service.stopPlay(studioId),
  };
  return { root, transport, service, playControl, config, studio: { id: "studio-1", name: "FixtureGame", placeId: 22 } };
}

function spec(assertions: PlaytestSpec["assertions"] = [{ type: "console_errors", maximum: 0 }]): PlaytestSpec {
  return {
    schema_version: 1,
    id: "smoke",
    title: "Smoke",
    setup: { mode: "play", timeout_seconds: 1 },
    steps: [{ action: "wait_for_player", id: "player", timeout_seconds: 1 }, { action: "capture", label: "spawned" }],
    assertions,
    cleanup: { stop_playtest: true },
  };
}

describe("fake Studio MCP integration", () => {
  it("connects, lists one Studio, starts/stops, executes input, and reads console", async () => {
    const { transport, service } = await fixture();
    await expect(service.listStudios()).resolves.toEqual([{ id: "studio-1", name: "FixtureGame", placeId: 22 }]);
    await expect(service.startPlay("studio-1")).resolves.toBe(true);
    await service.sendKeyboardInput("studio-1", [{ action: "keyPress", key_code: "E" }]);
    await service.sendMouseInput("studio-1", [{ action: "mouseButtonClick", mouse_button: "left" }]);
    await expect(service.getConsoleOutput("studio-1")).resolves.toEqual([]);
    await expect(service.stopPlay("studio-1")).resolves.toBe(true);
    expect(transport.calls.map((call) => call.name)).toContain(ToolName.KeyboardInput);
  });

  it("normalizes the current Studio MCP plain-text state response", async () => {
    const { transport, service } = await fixture();
    transport.stateFormat = "text";

    await expect(service.getStudioState("studio-1")).resolves.toMatchObject({
      mode: "edit",
      availableDataModels: ["Edit"],
    });
    transport.mode = "play";
    await expect(service.getStudioState("studio-1")).resolves.toMatchObject({
      mode: "play",
      availableDataModels: ["Client", "Server"],
    });
  });

  it("handles zero and multiple Studio lists without inventing a selection", async () => {
    const { transport, service } = await fixture();
    transport.studios = [];
    await expect(service.listStudios()).resolves.toEqual([]);
    transport.studios = [{ studio_id: "a", name: "A" }, { studio_id: "b", name: "B" }];
    await expect(service.listStudios()).resolves.toHaveLength(2);
  });

  it("fails when a requested capability is missing", async () => {
    const { transport } = await fixture();
    transport.tools = [{ name: ToolName.ListStudios, inputSchema: {} }];
    const second = new StudioService(transport, 100);
    await second.connect();
    expect(() => second.require([ToolName.ScreenCapture])).toThrowError(/screen_capture/u);
  });

  it("runs a full passing lifecycle and writes canonical artifacts", async () => {
    const { root, transport, service, playControl, config, studio } = await fixture();
    const outcome = await runPlaytest({ config, spec: spec(), source: "smoke", service, playControl, studio });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ status: "passed", cleanup: { status: "passed" } });
    expect(transport.mode).toBe("edit");
    const result = JSON.parse(await readFile(join(outcome.artifactDirectory, "result.json"), "utf8"));
    expect(result.run_id).toBe(outcome.result.run_id);
    await expect(readFile(join(outcome.artifactDirectory, "manifest.json"), "utf8")).resolves.toContain('"schema_version": 1');
    await expect(readFile(join(root, outcome.result.evidence.screenshots[0]!), "base64")).resolves.toBe(onePixelPng);
  });

  it("fails an assertion and still stops play mode", async () => {
    const { transport, service, playControl, config, studio } = await fixture();
    const outcome = await runPlaytest({
      config,
      spec: spec([
        {
          type: "probe",
          context: "client",
          code: "return true",
          operator: "equals",
          expected: false,
        },
      ]),
      source: "failure",
      service,
      playControl,
      studio,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.assertions.failed).toBe(1);
    expect(outcome.result.evidence.screenshots.some((path) => path.endsWith("failure.png"))).toBe(true);
    expect(transport.mode).toBe("edit");
  });

  it("times out a step and still executes cleanup", async () => {
    const { transport, service, playControl, config, studio } = await fixture();
    const timeoutSpec: PlaytestSpec = {
      schema_version: 1,
      id: "timeout",
      title: "Timeout",
      setup: { mode: "play", timeout_seconds: 1 },
      steps: [{ action: "wait", duration_ms: 50, timeout_seconds: 0.005 }],
      cleanup: { stop_playtest: true },
    };
    const outcome = await runPlaytest({ config, spec: timeoutSpec, source: "timeout", service, playControl, studio });
    expect(outcome.exitCode).toBe(6);
    expect(outcome.result.failure?.code).toBe("TIMEOUT");
    expect(outcome.result.cleanup.status).toBe("passed");
    expect(transport.mode).toBe("edit");
  });

  it("maps a cleanup failure to stable exit code 8", async () => {
    const { transport, service, playControl, config, studio } = await fixture();
    transport.failStop = true;
    const outcome = await runPlaytest({ config, spec: spec(), source: "cleanup", service, playControl, studio });
    expect(outcome.exitCode).toBe(8);
    expect(outcome.result.status).toBe("error");
    expect(outcome.result.cleanup.status).toBe("failed");
    expect(outcome.result.failure?.code).toBe("CLEANUP_FAILED");
  });

  it("enforces the workflow timeout without bypassing test cleanup", async () => {
    const { root, transport, service, playControl, config, studio } = await fixture();
    const playtests = join(root, "tests", "playtests");
    await mkdir(playtests, { recursive: true });
    await writeFile(
      join(playtests, "slow.yaml"),
      'schema_version: 1\nid: slow\ntitle: Slow\nsetup:\n  mode: play\nsteps:\n  - action: wait\n    duration_ms: 50\ncleanup:\n  stop_playtest: true\n',
    );
    const outcome = await runWorkflow({
      config,
      workflow: {
        schema_version: 1,
        name: "timed",
        tests: { include: ["tests/playtests/*.yaml"] },
        execution: { timeout_seconds: 0.005 },
        cleanup: { stop_playtest: true },
      },
      service,
      playControl,
      studio,
    });
    expect(outcome.exitCode).toBe(6);
    expect(outcome.tests[0]?.failure?.code).toBe("TIMEOUT");
    expect(transport.mode).toBe("edit");
  });
});
