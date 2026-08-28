import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import {
  SetupError,
  ensureSkillLink,
  inspectSkillLink,
  parseArgs,
} from "./setup.mjs";

const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url));

test("parseArgs accepts the complete non-interactive setup surface", () => {
  assert.deepEqual(parseArgs([]), {
    check: false,
    help: false,
    installCliLink: true,
    installSkill: true,
  });
  assert.deepEqual(parseArgs(["--check", "--no-cli-link", "--no-skill"]), {
    check: true,
    help: false,
    installCliLink: false,
    installSkill: false,
  });
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs rejects unknown options with a usage exit", () => {
  assert.throws(
    () => parseArgs(["--interactive"]),
    (error) => error instanceof SetupError && error.exitCode === 2 && /Unknown setup option/u.test(error.message),
  );
});

test("setup help and usage errors are valid TOON with stable exits", () => {
  const help = spawnSync(process.execPath, [setupPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  assert.equal(decode(help.stdout).description, "Install or verify Roblox Studio AXI for command-line agents");

  const invalid = spawnSync(process.execPath, [setupPath, "--interactive"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr, "");
  assert.match(decode(invalid.stdout).error, /Unknown setup option/u);

  const check = spawnSync(
    process.execPath,
    [setupPath, "--check", "--no-cli-link", "--no-skill"],
    { encoding: "utf8" },
  );
  assert.equal(check.status, 0);
  assert.equal(check.stderr, "");
  assert.deepEqual(decode(check.stdout), { status: "ready", cli: "skipped", skill: "skipped" });
});

test("ensureSkillLink installs idempotently", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "roblox-studio-axi-setup-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, "source");
  const target = join(fixture, "home", ".agents", "skills", "roblox-studio-axi");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: roblox-studio-axi\n---\n");

  assert.equal(await inspectSkillLink(source, target), "missing");
  assert.equal(await ensureSkillLink(source, target), "linked");
  assert.equal(await inspectSkillLink(source, target), "ready");
  assert.equal(await ensureSkillLink(source, target), "unchanged");
  assert.equal(await realpath(target), await realpath(source));
});

test("ensureSkillLink repairs a stale link", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "roblox-studio-axi-setup-repair-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, "source");
  const staleSource = join(fixture, "stale-source");
  const target = join(fixture, "home", ".agents", "skills", "roblox-studio-axi");
  await mkdir(source, { recursive: true });
  await mkdir(staleSource, { recursive: true });

  assert.equal(await ensureSkillLink(staleSource, target), "linked");
  assert.equal(await inspectSkillLink(source, target), "mismatch");
  assert.equal(await ensureSkillLink(source, target), "repaired");
  assert.equal(await realpath(target), await realpath(source));
});

test("ensureSkillLink preserves an existing real directory", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "roblox-studio-axi-setup-conflict-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const source = join(fixture, "source");
  const target = join(fixture, "home", ".agents", "skills", "roblox-studio-axi");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });

  await assert.rejects(
    ensureSkillLink(source, target),
    (error) => error instanceof SetupError && /not a link/u.test(error.message),
  );
});
