import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ExitCode, RobloxAxiError, messageFromUnknown } from "../../errors.js";
import type { McpLaunch } from "../cli/discover.js";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpTransport {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

function normalizeTool(tool: Tool): McpToolDescriptor {
  const normalized: McpToolDescriptor = {
    name: tool.name,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
  if (tool.description !== undefined) normalized.description = tool.description;
  return normalized;
}

export class SdkMcpTransport implements McpTransport {
  readonly #launch: McpLaunch;
  #client: Client | undefined;
  #stderr = "";

  constructor(launch: McpLaunch) {
    this.#launch = launch;
  }

  async connect(): Promise<void> {
    const client = new Client({ name: "roblox-studio-axi", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: this.#launch.command,
      args: this.#launch.args,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-4_000);
    });
    try {
      await client.connect(transport);
      this.#client = client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new RobloxAxiError({
        message: `Studio MCP connection failed: ${messageFromUnknown(error)}`,
        code: "MCP_CONNECTION_FAILED",
        exitCode: ExitCode.McpFailure,
        suggestions: [
          "Enable Studio as an MCP server in Assistant settings",
          "Restart Studio and verify the documented MCP launcher",
        ],
        details: this.#stderr.trim() || undefined,
        cause: error,
      });
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.#client) throw this.#notConnected();
    return (await this.#client.listTools()).tools.map(normalizeTool);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.#client) throw this.#notConnected();
    const result = await this.#client.callTool({ name, arguments: args });
    return result as McpCallResult;
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) await client.close();
  }

  #notConnected(): RobloxAxiError {
    return new RobloxAxiError({
      message: "Studio MCP is not connected",
      code: "MCP_CONNECTION_FAILED",
      exitCode: ExitCode.McpFailure,
    });
  }
}
