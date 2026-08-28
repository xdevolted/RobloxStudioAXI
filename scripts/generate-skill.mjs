import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GUIDANCE, SKILL_DESCRIPTION } from "../dist/src/guidance.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "skills", "roblox-studio-axi", "SKILL.md");
const content = `---
name: roblox-studio-axi
description: ${SKILL_DESCRIPTION}
---

# Roblox Studio AXI

${AGENT_GUIDANCE.description}

${AGENT_GUIDANCE.rules.map((rule) => `- ${rule}`).join("\n")}

## Discover the current project

Run \`roblox-studio-axi\` or \`roblox-studio-axi status\` from a game repository containing \`.axi/config.toml\`.
Use \`roblox-studio-axi studios list\` before supplying \`--studio <id>\` when selection is ambiguous.

## Validate before execution

Run \`roblox-studio-axi test validate <spec>\` when authoring or changing a playtest specification.
Canonical CI output is written to the reported artifact directory as \`result.json\`.
`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== content) {
    process.stderr.write("skills/roblox-studio-axi/SKILL.md is stale; run npm run skill:generate\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, content);
}
