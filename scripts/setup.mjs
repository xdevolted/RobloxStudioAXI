#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "roblox-studio-axi";
const MINIMUM_NODE_MAJOR = 20;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class SetupError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SetupError";
    this.exitCode = options.exitCode ?? 1;
    this.help = options.help;
    this.details = options.details;
  }
}

export function parseArgs(args) {
  const options = {
    check: false,
    help: false,
    installCliLink: true,
    installSkill: true,
  };

  for (const arg of args) {
    switch (arg) {
      case "--check":
        options.check = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--no-cli-link":
        options.installCliLink = false;
        break;
      case "--no-skill":
        options.installSkill = false;
        break;
      default:
        throw new SetupError(`Unknown setup option: ${arg}`, {
          exitCode: 2,
          help: "Run `node scripts/setup.mjs --help` for the supported options",
        });
    }
  }

  return options;
}

function samePath(left, right) {
  const normalize = (value) => resolve(value).replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inspectSkillLink(source, target) {
  const state = await pathState(target);
  if (!state) return "missing";
  if (!state.isSymbolicLink()) return "conflict";
  try {
    return samePath(await realpath(target), await realpath(source)) ? "ready" : "mismatch";
  } catch (error) {
    if (error?.code === "ENOENT") return "mismatch";
    throw error;
  }
}

export async function ensureSkillLink(source, target, platform = process.platform) {
  const state = await inspectSkillLink(source, target);
  if (state === "ready") return "unchanged";
  if (state === "conflict") {
    throw new SetupError(`The skill target exists and is not a link: ${target}`, {
      help: "Move that directory aside, then run `node scripts/setup.mjs` again",
    });
  }
  if (state === "mismatch") await unlink(target);

  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, platform === "win32" ? "junction" : "dir");
  return state === "mismatch" ? "repaired" : "linked";
}

async function npmInvocation(args, environment = process.env) {
  if (environment.npm_execpath) {
    return { command: process.execPath, args: [environment.npm_execpath, ...args], shell: false };
  }
  if (process.platform === "win32") {
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (await pathState(npmCli)) {
      return { command: process.execPath, args: [npmCli, ...args], shell: false };
    }
    throw new SetupError("npm was not found next to the Node.js executable", {
      help: "Install the standard Node.js distribution with npm, then run setup again",
    });
  }
  return {
    command: "npm",
    args,
    shell: false,
  };
}

function sanitizeDiagnostics(value) {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1***@")
    .replace(/(_authToken\s*=\s*)\S+/giu, "$1***")
    .slice(-4_000);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (options.progress) options.stderr.write(`setup: ${options.progress}\n`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", (error) => rejectPromise(new SetupError(`Unable to start ${options.label}`, {
      help: options.help,
      details: error.message,
    })));
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      rejectPromise(new SetupError(`${options.label} failed with exit code ${code ?? 1}`, {
        help: options.help,
        details: sanitizeDiagnostics(`${stdout}\n${stderr}`.trim()),
      }));
    });
  });
}

async function runNpm(args, options = {}) {
  const invocation = await npmInvocation(args, options.environment);
  return runProcess(invocation.command, invocation.args, {
    cwd: options.cwd ?? root,
    environment: options.environment ?? process.env,
    help: options.help,
    label: options.label ?? `npm ${args.join(" ")}`,
    progress: options.progress,
    shell: invocation.shell,
    stderr: options.stderr ?? process.stderr,
  });
}

async function inspectCliLink(repositoryRoot, options = {}) {
  if (!(await pathState(join(repositoryRoot, "dist", "bin", "roblox-studio-axi.js")))) {
    return "missing-build";
  }
  let globalRoot;
  try {
    globalRoot = await runNpm(["root", "-g"], {
      cwd: repositoryRoot,
      environment: options.environment,
      label: "global npm root lookup",
      stderr: options.stderr,
    });
  } catch {
    return "missing";
  }
  const globalPackage = join(globalRoot.split(/\r?\n/u).at(-1), PACKAGE_NAME);
  try {
    return samePath(await realpath(globalPackage), await realpath(repositoryRoot)) ? "ready" : "mismatch";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function skillPaths(repositoryRoot, userHome = homedir()) {
  return {
    source: join(repositoryRoot, "skills", "roblox-studio-axi"),
    target: join(userHome, ".agents", "skills", "roblox-studio-axi"),
  };
}

function quote(value) {
  return JSON.stringify(String(value));
}

function printHelp(stdout) {
  stdout.write(`description: Install or verify Roblox Studio AXI for command-line agents\n`);
  stdout.write(`usage: ${quote("node scripts/setup.mjs [--check] [--no-cli-link] [--no-skill]")}\n`);
  stdout.write("flags[4]{name,description}:\n");
  stdout.write(`  ${quote("--check")},${quote("Verify the existing installation without changing it")}\n`);
  stdout.write(`  ${quote("--no-cli-link")},${quote("Do not create or verify the global npm CLI link")}\n`);
  stdout.write(`  ${quote("--no-skill")},${quote("Do not register or verify the user-level agent skill")}\n`);
  stdout.write(`  ${quote("--help, -h")},${quote("Show this help")}\n`);
}

function printStatus(stdout, status) {
  stdout.write(`status: ${status.ready ? "ready" : "incomplete"}\n`);
  stdout.write(`cli: ${status.cli}\n`);
  stdout.write(`skill: ${status.skill}\n`);
  if (status.skillPath) stdout.write(`skill_path: ${quote(status.skillPath)}\n`);
  if (!status.ready) {
    stdout.write(`help[1]: ${quote("Run `node scripts/setup.mjs` to install or repair Roblox Studio AXI")}\n`);
  }
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    throw new SetupError(`Node.js ${MINIMUM_NODE_MAJOR} or newer is required; found ${process.versions.node}`, {
      help: `Install Node.js ${MINIMUM_NODE_MAJOR} or newer, then run \`node scripts/setup.mjs\` again`,
    });
  }
}

async function assertRepositoryFiles(repositoryRoot) {
  const packageValue = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (packageValue.name !== PACKAGE_NAME) {
    throw new SetupError(`Setup must run from the ${PACKAGE_NAME} repository`, {
      help: "Clone RobloxStudioAXI, change into that directory, and run `node scripts/setup.mjs`",
    });
  }
  await readFile(join(repositoryRoot, "package-lock.json"), "utf8");
  await readFile(join(repositoryRoot, "skills", "roblox-studio-axi", "SKILL.md"), "utf8");
}

async function installationStatus(repositoryRoot, options, dependencies = {}) {
  const paths = skillPaths(repositoryRoot, dependencies.userHome);
  const cli = options.installCliLink
    ? await inspectCliLink(repositoryRoot, dependencies)
    : "skipped";
  const skill = options.installSkill
    ? await inspectSkillLink(paths.source, paths.target)
    : "skipped";
  return {
    ready: (!options.installCliLink || cli === "ready") && (!options.installSkill || skill === "ready"),
    cli,
    skill,
    skillPath: options.installSkill ? paths.target : undefined,
  };
}

export async function runSetup(options, dependencies = {}) {
  const repositoryRoot = dependencies.repositoryRoot ?? root;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  assertNodeVersion();
  await assertRepositoryFiles(repositoryRoot);

  if (options.check) {
    const status = await installationStatus(repositoryRoot, options, {
      ...dependencies,
      stderr,
    });
    printStatus(stdout, status);
    return status.ready ? 0 : 1;
  }

  await runNpm(["ci", "--no-audit", "--no-fund"], {
    cwd: repositoryRoot,
    environment: dependencies.environment,
    help: "Resolve npm access or network errors, then run `node scripts/setup.mjs` again",
    label: "dependency installation",
    progress: "installing locked dependencies",
    stderr,
  });
  await runNpm(["run", "check"], {
    cwd: repositoryRoot,
    environment: dependencies.environment,
    help: "Run `npm run check` for the failing verification details",
    label: "project verification",
    progress: "building and verifying the project",
    stderr,
  });
  if (options.installCliLink) {
    await runNpm(["link"], {
      cwd: repositoryRoot,
      environment: dependencies.environment,
      help: "Check the npm global prefix permissions, then run `node scripts/setup.mjs` again",
      label: "global CLI link",
      progress: "linking the roblox-studio-axi command",
      stderr,
    });
  }
  if (options.installSkill) {
    const paths = skillPaths(repositoryRoot, dependencies.userHome);
    stderr.write("setup: registering the user-level agent skill\n");
    await ensureSkillLink(paths.source, paths.target, dependencies.platform);
  }

  const status = await installationStatus(repositoryRoot, options, {
    ...dependencies,
    stderr,
  });
  if (!status.ready) {
    throw new SetupError("Setup finished but verification is incomplete", {
      help: "Run `node scripts/setup.mjs --check` to inspect the installation state",
    });
  }
  printStatus(stdout, status);
  return 0;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      printHelp(process.stdout);
      return 0;
    }
    return await runSetup(options);
  } catch (error) {
    const setupError = error instanceof SetupError
      ? error
      : new SetupError(error instanceof Error ? error.message : String(error));
    process.stdout.write(`error: ${quote(setupError.message)}\n`);
    if (setupError.help) {
      process.stdout.write(`help[1]: ${quote(setupError.help)}\n`);
    }
    if (setupError.details) process.stderr.write(`${setupError.details}\n`);
    return setupError.exitCode;
  }
}

const directInvocation = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directInvocation) process.exitCode = await main();
