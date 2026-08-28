import { ExitCode, RobloxAxiError, messageFromUnknown } from "../errors.js";
import type {
  ConsoleEntry,
  DataModelContext,
  ScreenshotData,
  StudioInstance,
  StudioMode,
  StudioState,
} from "../types.js";
import { pollUntil, withTimeout } from "../runner/timeout.js";
import {
  normalizeCapabilities,
  requireCapabilities,
  ToolName,
  type KnownToolName,
  type NormalizedCapabilities,
} from "./mcp/capabilities.js";
import type { McpCallResult, McpTransport } from "./mcp/transport.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase();
}

function findByKeys(value: unknown, keys: string[]): unknown {
  const wanted = new Set(keys.map(normalizeKey));
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (wanted.has(normalizeKey(key))) return child;
      queue.push(child);
    }
  }
  return undefined;
}

function textBlocks(result: McpCallResult): string[] {
  return (result.content ?? [])
    .filter((block): block is { type: string; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text);
}

function resultMessage(result: McpCallResult): string {
  return textBlocks(result).join("\n").trim() || "Studio MCP tool call failed";
}

export function extractToolPayload(result: McpCallResult): unknown {
  if (result.isError) {
    throw new RobloxAxiError({
      message: resultMessage(result),
      code: "MCP_CONNECTION_FAILED",
      exitCode: ExitCode.McpFailure,
    });
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = textBlocks(result);
  if (texts.length === 0) return null;
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]!);
    } catch {
      return texts[0];
    }
  }
  return texts;
}

function normalizeMode(value: unknown): StudioMode {
  const text = String(value ?? "edit").toLocaleLowerCase();
  if (text.includes("pause")) return "paused";
  if (text.includes("play") || text.includes("run")) return "play";
  return "edit";
}

function studioStateFromText(value: string): {
  mode: StudioMode;
  availableDataModels: string[];
} {
  const mode = /^\s*-?\s*Current Studio Mode:\s*([^\r\n]+)$/imu.exec(value)?.[1];
  const available = /^\s*-?\s*Available DataModels?:\s*([^\r\n]+)$/imu.exec(value)?.[1];
  return {
    mode: normalizeMode(mode),
    availableDataModels: available === undefined
      ? []
      : available.split(",").map((item) => item.trim()).filter(Boolean),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  return undefined;
}

function normalizeStudio(value: unknown): StudioInstance | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.studio_id ?? value.studioId ?? value.id;
  const name = value.name ?? value.place_name ?? value.placeName ?? "Unnamed Studio";
  if (typeof id !== "string" || id.length === 0) return undefined;
  const studio: StudioInstance = { id, name: String(name) };
  const placeId = numberOrUndefined(value.place_id ?? value.placeId);
  if (placeId !== undefined) studio.placeId = placeId;
  return studio;
}

function normalizeStudios(payload: unknown): StudioInstance[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.studios)
      ? payload.studios
      : [];
  return values.map(normalizeStudio).filter((studio): studio is StudioInstance => Boolean(studio));
}

function normalizeConsole(payload: unknown): ConsoleEntry[] {
  let values: unknown[] = [];
  if (Array.isArray(payload)) values = payload;
  if (isRecord(payload)) {
    const candidate = findByKeys(payload, ["messages", "output", "entries", "logs", "console"]);
    if (Array.isArray(candidate)) values = candidate;
  }
  if (values.length === 0 && typeof payload === "string") {
    values = payload.split(/\r?\n/u).filter(Boolean);
  }
  return values.map((value) => {
    if (typeof value === "string") return { level: "info" as const, message: value };
    const record = isRecord(value) ? value : { message: String(value) };
    const levelText = String(
      record.level ?? record.type ?? record.messageType ?? record.severity ?? "info",
    ).toLocaleLowerCase();
    const level = levelText.includes("error")
      ? "error"
      : levelText.includes("warn")
        ? "warning"
        : "info";
    const entry: ConsoleEntry = {
      level,
      message: String(record.message ?? record.text ?? record.output ?? value),
    };
    const timestamp = record.timestamp ?? record.time;
    if (timestamp !== undefined) entry.timestamp = String(timestamp);
    return entry;
  });
}

function contextName(context: DataModelContext): "Edit" | "Client" | "Server" {
  return `${context[0]!.toLocaleUpperCase()}${context.slice(1)}` as "Edit" | "Client" | "Server";
}

export class StudioService {
  readonly #transport: McpTransport;
  readonly #operationTimeoutMs: number;
  #capabilities: NormalizedCapabilities | undefined;

  constructor(transport: McpTransport, operationTimeoutMs = 30_000) {
    this.#transport = transport;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  get capabilities(): NormalizedCapabilities {
    if (!this.#capabilities) {
      throw new RobloxAxiError({
        message: "Studio MCP capabilities have not been discovered",
        code: "MCP_CONNECTION_FAILED",
        exitCode: ExitCode.McpFailure,
      });
    }
    return this.#capabilities;
  }

  async connect(): Promise<void> {
    try {
      await withTimeout("Studio MCP connection", this.#operationTimeoutMs, () => this.#transport.connect());
      this.#capabilities = normalizeCapabilities(await this.#transport.listTools());
      requireCapabilities(this.#capabilities, [ToolName.ListStudios]);
    } catch (error) {
      if (error instanceof RobloxAxiError) throw error;
      throw new RobloxAxiError({
        message: `Studio MCP connection failed: ${messageFromUnknown(error)}`,
        code: "MCP_CONNECTION_FAILED",
        exitCode: ExitCode.McpFailure,
        cause: error,
      });
    }
  }

  close(): Promise<void> {
    return this.#transport.close();
  }

  require(required: readonly KnownToolName[]): void {
    requireCapabilities(this.capabilities, required);
  }

  async #call(name: KnownToolName, args: JsonRecord): Promise<McpCallResult> {
    this.require([name]);
    return withTimeout(`Studio MCP ${name}`, this.#operationTimeoutMs, () =>
      this.#transport.callTool(name, args),
    );
  }

  async listStudios(): Promise<StudioInstance[]> {
    return normalizeStudios(extractToolPayload(await this.#call(ToolName.ListStudios, {})));
  }

  async getStudioState(studioId: string): Promise<StudioState> {
    const raw = extractToolPayload(
      await this.#call(ToolName.StudioState, { studio_id: studioId }),
    );
    if (typeof raw === "string") {
      return { ...studioStateFromText(raw), raw };
    }
    const available = findByKeys(raw, ["available_datamodel_types", "availableDataModels", "datamodel_types"]);
    return {
      mode: normalizeMode(findByKeys(raw, ["play_state", "playState", "state", "mode"])),
      availableDataModels: Array.isArray(available) ? available.map(String) : [],
      raw,
    };
  }

  async startPlay(studioId: string): Promise<boolean> {
    const state = await this.getStudioState(studioId);
    if (state.mode === "play") return false;
    extractToolPayload(
      await this.#call(ToolName.StartStopPlay, { studio_id: studioId, is_start: true }),
    );
    return true;
  }

  async stopPlay(studioId: string): Promise<boolean> {
    const state = await this.getStudioState(studioId);
    if (state.mode === "edit") return false;
    extractToolPayload(
      await this.#call(ToolName.StartStopPlay, { studio_id: studioId, is_start: false }),
    );
    return true;
  }

  async waitForState(studioId: string, mode: StudioMode, timeoutMs: number): Promise<StudioState> {
    return pollUntil({
      operation: `Studio state ${mode}`,
      timeoutMs,
      read: () => this.getStudioState(studioId),
      accept: (state) => state.mode === mode,
    });
  }

  async executeLuau(studioId: string, context: DataModelContext, code: string): Promise<unknown> {
    const raw = extractToolPayload(
      await this.#call(ToolName.ExecuteLuau, {
        studio_id: studioId,
        datamodel_type: contextName(context),
        code,
      }),
    );
    if (isRecord(raw)) {
      const result = findByKeys(raw, ["result", "value", "return_value", "returnValue"]);
      if (result !== undefined) return result;
    }
    return raw;
  }

  async waitForPlayer(studioId: string, timeoutMs: number): Promise<void> {
    await pollUntil({
      operation: "player readiness",
      timeoutMs,
      read: () =>
        this.executeLuau(
          studioId,
          "client",
          'local player = game:GetService("Players").LocalPlayer; return player ~= nil and player.Character ~= nil',
        ).catch(() => false),
      accept: (value) => value === true || value === "true" || findByKeys(value, ["result"]) === true,
    });
  }

  async getConsoleOutput(studioId: string): Promise<ConsoleEntry[]> {
    return normalizeConsole(
      extractToolPayload(await this.#call(ToolName.ConsoleOutput, { studio_id: studioId })),
    );
  }

  async captureScreen(studioId: string, captureId: string): Promise<ScreenshotData> {
    const result = await this.#call(ToolName.ScreenCapture, {
      studio_id: studioId,
      capture_id: captureId,
    });
    if (result.isError) extractToolPayload(result);
    const image = (result.content ?? []).find(
      (block): block is { type: "image"; data: string; mimeType: string } =>
        isRecord(block) &&
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string",
    );
    if (image) return { data: image.data, mimeType: image.mimeType };
    const payload = extractToolPayload(result);
    const data = findByKeys(payload, ["data", "image_data", "imageData"]);
    const mimeType = findByKeys(payload, ["mime_type", "mimeType"]);
    if (typeof data === "string") {
      return { data, mimeType: typeof mimeType === "string" ? mimeType : "image/png" };
    }
    throw new RobloxAxiError({
      message: "Studio MCP screen capture returned no image data",
      code: "MCP_CONNECTION_FAILED",
      exitCode: ExitCode.McpFailure,
    });
  }

  async navigateCharacter(
    studioId: string,
    options: { position?: [number, number, number]; instancePath?: string; speedMultiplier?: number },
  ): Promise<unknown> {
    const args: JsonRecord = { studio_id: studioId, datamodel_type: "Client" };
    if (options.instancePath) args.instance_path = options.instancePath;
    if (options.position) [args.x, args.y, args.z] = options.position;
    if (options.speedMultiplier !== undefined) args.speed_multiplier = options.speedMultiplier;
    return extractToolPayload(await this.#call(ToolName.CharacterNavigation, args));
  }

  async sendKeyboardInput(
    studioId: string,
    actions: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    return extractToolPayload(
      await this.#call(ToolName.KeyboardInput, {
        studio_id: studioId,
        datamodel_type: "Client",
        actions,
      }),
    );
  }

  async sendMouseInput(
    studioId: string,
    actions: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    return extractToolPayload(
      await this.#call(ToolName.MouseInput, {
        studio_id: studioId,
        datamodel_type: "Client",
        actions,
      }),
    );
  }
}

export function consoleDelta(before: ConsoleEntry[], after: ConsoleEntry[]): ConsoleEntry[] {
  let common = 0;
  while (
    common < before.length &&
    common < after.length &&
    before[common]!.level === after[common]!.level &&
    before[common]!.message === after[common]!.message
  ) {
    common += 1;
  }
  return after.slice(common === before.length ? common : 0);
}
