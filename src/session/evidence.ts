import { createHash } from "node:crypto";
import { appendFile, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "../version.js";
import { validateSchema } from "../project/schema.js";
import type {
  BootstrapArtifacts,
  ManagedSessionRecord,
  SessionCommand,
  SessionEnvironment,
  SessionEvidence,
  SessionObservation,
  SessionOperation,
  SessionOutcome,
} from "./types.js";

async function writeAtomic(path: string, value: unknown, nonce: string): Promise<void> {
  const temporary = `${path}.${nonce}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function luauString(value: string): string {
  let equals = "";
  while (value.includes(`]${equals}]`)) equals += "=";
  return `[${equals}[${value}]${equals}]`;
}

export function managedSessionBootstrap(record: ManagedSessionRecord): string {
  const ownership = record.ownership;
  return [
    "local testService = game:GetService([[StudioTestService]])",
    "local ownership = {",
    `  protocol = ${luauString(ownership.protocol)},`,
    `  session_id = ${luauString(ownership.sessionId)},`,
    `  project_root = ${luauString(ownership.projectRoot)},`,
    `  launch_target = ${luauString(ownership.launchTarget)},`,
    `  requested_clients = ${ownership.requestedClients},`,
    "}",
    `print([[AXI_MANAGED_SESSION_BOOTSTRAP]], ${luauString(ownership.sessionId)})`,
    `local result = testService:ExecuteMultiplayerTestAsync(${record.clients}, ownership)`,
    `print([[AXI_MANAGED_SESSION_COMPLETE]], ${luauString(ownership.sessionId)})`,
    "return result",
    "",
  ].join("\n");
}

class FileSessionOperation implements SessionOperation {
  readonly directory: string;
  readonly #environment: SessionEnvironment;
  readonly #startedAt: Date;

  constructor(directory: string, environment: SessionEnvironment, startedAt: Date) {
    this.directory = directory;
    this.#environment = environment;
    this.#startedAt = startedAt;
  }

  async prepareBootstrap(record: ManagedSessionRecord): Promise<BootstrapArtifacts> {
    const scriptPath = join(this.directory, "bootstrap.luau");
    const logPath = join(this.directory, "bootstrap.log");
    const script = managedSessionBootstrap(record);
    await writeFile(scriptPath, script, { encoding: "utf8", flag: "wx" });
    await writeFile(logPath, "", { encoding: "utf8", flag: "wx" });
    await writeFile(
      join(this.directory, "bootstrap.sha256"),
      `${createHash("sha256").update(script).digest("hex")}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return { scriptPath, logPath };
  }

  appendObservation(observation: SessionObservation): Promise<void> {
    return appendFile(
      join(this.directory, "observations.jsonl"),
      `${JSON.stringify(observation)}\n`,
      "utf8",
    );
  }

  action(name: string): Promise<void> {
    return appendFile(
      join(this.directory, "actions.jsonl"),
      `${JSON.stringify({ at: this.#environment.now().toISOString(), action: name })}\n`,
      "utf8",
    );
  }

  async finish(outcome: SessionOutcome): Promise<void> {
    const finishedAt = this.#environment.now();
    const result = {
      schema_version: 1 as const,
      response: outcome.response,
      exit_code: outcome.exitCode,
      started_at: this.#startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - this.#startedAt.getTime(),
    };
    await validateSchema("session-result", result);
    await writeAtomic(
      join(this.directory, "result.json"),
      result,
      this.#environment.id(),
    );
  }
}

export class FileSessionEvidence implements SessionEvidence {
  readonly #root: string;
  readonly #environment: SessionEnvironment;

  constructor(options: { root: string; environment: SessionEnvironment }) {
    this.#root = options.root;
    this.#environment = options.environment;
  }

  async begin(
    command: "session.start" | "session.stop",
    request: unknown,
  ): Promise<SessionOperation> {
    const startedAt = this.#environment.now();
    const operationId = this.#environment.id();
    const directory = join(this.#root, operationId);
    await mkdir(this.#root, { recursive: true });
    await mkdir(directory, { recursive: false });
    const controller = await this.#environment.controller();
    const manifest = {
      schema_version: 1,
      axi_version: VERSION,
      operation_id: operationId,
      command,
      request,
      controller,
      started_at: startedAt.toISOString(),
    };
    await validateSchema("session-operation-manifest", manifest);
    await writeAtomic(join(directory, "manifest.json"), manifest, this.#environment.id());
    return new FileSessionOperation(directory, this.#environment, startedAt);
  }
}

export type MutatingSessionCommand = Extract<SessionCommand, "session.start" | "session.stop">;
