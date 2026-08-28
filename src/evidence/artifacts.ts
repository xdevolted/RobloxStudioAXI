import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import type {
  ConsoleEntry,
  ResolvedProjectConfig,
  RunManifest,
  ScreenshotData,
  TestResult,
} from "../types.js";
import { VERSION } from "../version.js";
import { validateSchema } from "../project/schema.js";

const execFileAsync = promisify(execFile);

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function runId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `${timestamp}-${randomBytes(6).toString("hex")}`;
}

async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function gitSha(root: string): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      windowsHide: true,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function screenshotExtension(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  return ".png";
}

export class RunArtifacts {
  readonly runId: string;
  readonly directory: string;
  readonly #config: ResolvedProjectConfig;
  readonly #screenshotsDirectory: string;

  private constructor(config: ResolvedProjectConfig, id: string) {
    this.#config = config;
    this.runId = id;
    this.directory = join(config.evidence.directory, id);
    this.#screenshotsDirectory = join(this.directory, "screenshots");
  }

  static async create(config: ResolvedProjectConfig): Promise<RunArtifacts> {
    const artifacts = new RunArtifacts(config, runId());
    await mkdir(artifacts.#screenshotsDirectory, { recursive: true });
    return artifacts;
  }

  relative(path: string): string {
    return portableRelative(this.#config.root, path);
  }

  async writeManifest(options: {
    testId: string;
    source: string;
    studioId: string;
    placeId?: number;
    startedAt: string;
  }): Promise<RunManifest> {
    const manifest: RunManifest = {
      schema_version: 1,
      axi_version: VERSION,
      run_id: this.runId,
      test_id: options.testId,
      test_spec_digest: createHash("sha256").update(options.source).digest("hex"),
      project: this.#config.project.name,
      git_sha: await gitSha(this.#config.root),
      studio_id: options.studioId,
      place_id: options.placeId ?? null,
      started_at: options.startedAt,
      configuration: {
        environment: this.#config.safety.environment,
        screenshots: this.#config.evidence.screenshots,
        console: this.#config.evidence.console,
        always_stop_playtest: this.#config.safety.alwaysStopPlaytest,
      },
    };
    await validateSchema<RunManifest>("run-manifest", manifest);
    await writeAtomic(join(this.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async writeScreenshot(label: string, screenshot: ScreenshotData): Promise<string> {
    const path = join(this.#screenshotsDirectory, `${label}${screenshotExtension(screenshot.mimeType)}`);
    const data = screenshot.data.startsWith("data:")
      ? screenshot.data.slice(screenshot.data.indexOf(",") + 1)
      : screenshot.data;
    await writeAtomic(path, Buffer.from(data, "base64"));
    return this.relative(path);
  }

  async writeConsole(entries: ConsoleEntry[]): Promise<string> {
    const filtered = entries.filter((entry) => {
      if (this.#config.evidence.console === "all") return true;
      if (this.#config.evidence.console === "errors") return entry.level === "error";
      return entry.level === "error" || entry.level === "warning";
    });
    const path = join(this.directory, "console.log");
    const text = filtered
      .map((entry) => `${entry.timestamp ? `${entry.timestamp} ` : ""}[${entry.level}] ${entry.message}`)
      .join("\n");
    await writeAtomic(path, text.length > 0 ? `${text}\n` : "");
    return this.relative(path);
  }

  async writeResult(result: TestResult): Promise<void> {
    await validateSchema<TestResult>("result", result);
    await writeAtomic(join(this.directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const report = [
      `# Playtest ${result.test_id}`,
      "",
      `- Run: \`${result.run_id}\``,
      `- Status: **${result.status}**`,
      `- Duration: ${(result.duration_ms / 1_000).toFixed(2)}s`,
      `- Assertions: ${result.assertions.passed} passed, ${result.assertions.failed} failed`,
      `- Console: ${result.console.errors} errors, ${result.console.warnings} warnings`,
      `- Cleanup: ${result.cleanup.status}`,
      ...(result.failure ? ["", "## Failure", "", `${result.failure.code}: ${result.failure.message}`] : []),
      "",
    ].join("\n");
    await writeAtomic(join(this.directory, "report.md"), report);
  }
}

export function isResultFile(path: string): boolean {
  return extname(path).toLocaleLowerCase() === ".json";
}
