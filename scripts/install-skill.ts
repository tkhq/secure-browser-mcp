/**
 * Copy the bundled Agent Skill into an agent's skills directory:
 *
 *   bun run scripts/install-skill.ts --claude            # ~/.claude/skills/
 *   bun run scripts/install-skill.ts --claude --project  # ./.claude/skills/
 *   bun run scripts/install-skill.ts --codex             # ~/.codex/skills/
 *   bun run scripts/install-skill.ts --hermes            # $HERMES_HOME/skills/ or ~/.hermes/skills/
 *
 * A skill is just a folder (agentskills.io) — this script is a convenience,
 * not a requirement. Refuses to overwrite an existing install unless --force.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "secure-browser";
const SKILL_SRC = fileURLToPath(
  new URL(`../skills/${SKILL_NAME}`, import.meta.url),
);

const args = new Set(process.argv.slice(2));
const force = args.delete("--force");
const project = args.delete("--project");
if (project && args.has("--hermes")) {
  console.error(
    "--hermes does not support --project; set HERMES_HOME to your profile directory instead.",
  );
  process.exit(1);
}

const targets: string[] = [];
if (args.delete("--claude")) {
  targets.push(
    project
      ? join(process.cwd(), ".claude", "skills")
      : join(homedir(), ".claude", "skills"),
  );
}
if (args.delete("--codex")) {
  targets.push(join(homedir(), ".codex", "skills"));
}
if (args.delete("--hermes")) {
  targets.push(
    join(process.env["HERMES_HOME"] || join(homedir(), ".hermes"), "skills"),
  );
}
if (args.size > 0) {
  console.error(`Unknown arguments: ${[...args].join(" ")}`);
  process.exit(1);
}
if (targets.length === 0) {
  console.error(
    "Usage: bun run scripts/install-skill.ts [--claude [--project]] [--codex] [--hermes] [--force]",
  );
  process.exit(1);
}

for (const dir of targets) {
  const dest = join(dir, SKILL_NAME);
  if (existsSync(dest)) {
    if (!force) {
      console.error(`refuse ${dest} exists (use --force to overwrite)`);
      process.exitCode = 1;
      continue;
    }
    rmSync(dest, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
  cpSync(SKILL_SRC, dest, { recursive: true });
  console.log(`installed ${dest}`);
}
