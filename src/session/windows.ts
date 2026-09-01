import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ProcessIdentity, SessionEnvironment } from "./types.js";

const execFileAsync = promisify(execFile);

export type WindowsStudioRole = "edit" | "bootstrap" | "server" | "client";

export interface WindowsProcessInfo {
  identity?: ProcessIdentity;
  parentPid: number;
  executable: string;
  commandLine: string;
  role: WindowsStudioRole;
}

interface CimProcessRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CreationDate?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
}

function normalizeCreationTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value
    .replace(/\.(\d{3})\d+/u, ".$1")
    .replace(/([+-]\d{2})(\d)$/u, "$1:0$2")
    .replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function roleFromCommandLine(commandLine: string): WindowsStudioRole {
  if (/\s-?-?task\s+StartServer(?:\s|$)/iu.test(commandLine)) return "server";
  if (/\s-?-?task\s+StartClient(?:\s|$)/iu.test(commandLine)) return "client";
  if (/\s--task\s+RunScript(?:\s|$)/iu.test(commandLine)) return "bootstrap";
  return "edit";
}

export function normalizeWindowsProcessRows(rows: CimProcessRow[]): WindowsProcessInfo[] {
  return rows
    .map((row): WindowsProcessInfo | undefined => {
      const pid = Number(row.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const createdAt = normalizeCreationTime(row.CreationDate);
      const commandLine = typeof row.CommandLine === "string" ? row.CommandLine : "";
      return {
        ...(createdAt === undefined ? {} : { identity: { pid, createdAt } }),
        parentPid: Number(row.ParentProcessId) || 0,
        executable: typeof row.ExecutablePath === "string" ? row.ExecutablePath : "",
        commandLine,
        role: roleFromCommandLine(commandLine),
      };
    })
    .filter((item): item is WindowsProcessInfo => item !== undefined);
}

async function queryCim(filter: string): Promise<WindowsProcessInfo[]> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rows = @(Get-CimInstance Win32_Process -Filter ${JSON.stringify(filter)} | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath,CommandLine)`,
    "$rows | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!stdout.trim()) return [];
  const value = JSON.parse(stdout) as CimProcessRow | CimProcessRow[];
  return normalizeWindowsProcessRows(Array.isArray(value) ? value : [value]);
}

export class WindowsProcessInventory {
  async studios(): Promise<WindowsProcessInfo[]> {
    if (process.platform !== "win32") return [];
    return queryCim("Name='RobloxStudioBeta.exe'");
  }

  async identity(pid: number): Promise<ProcessIdentity | undefined> {
    if (process.platform !== "win32") {
      if (pid === process.pid) {
        return { pid, createdAt: new Date(Date.now() - process.uptime() * 1_000).toISOString() };
      }
      return undefined;
    }
    return (await queryCim(`ProcessId=${pid}`))[0]?.identity;
  }

  async exists(expected: ProcessIdentity): Promise<boolean> {
    const actual = await this.identity(expected.pid);
    return actual?.createdAt === expected.createdAt;
  }
}

export class ProductionSessionEnvironment implements SessionEnvironment {
  readonly #inventory: WindowsProcessInventory;

  constructor(inventory = new WindowsProcessInventory()) {
    this.#inventory = inventory;
  }

  now(): Date {
    return new Date();
  }

  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  }

  id(): string {
    return randomUUID();
  }

  async controller(): Promise<ProcessIdentity> {
    const identity = await this.#inventory.identity(process.pid);
    if (!identity) throw new Error(`Unable to resolve controller process identity for PID ${process.pid}`);
    return identity;
  }

  processExists(identity: ProcessIdentity): Promise<boolean> {
    return this.#inventory.exists(identity);
  }
}
