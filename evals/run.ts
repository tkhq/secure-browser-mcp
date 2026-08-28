/**
 * Eval runner: drives a real coding agent, headless, against the MCP server
 * (mock backend) and grades the tool-call transcript. Usage:
 *
 *   bun run evals/run.ts [--agent claude] [--case login] [--model <model>]
 *
 * The agent runs in a throwaway working directory with the bundled skill
 * installed at .claude/skills/secure-browser, so every eval also tests that
 * the skill's instructions actually steer the agent.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./adapters/claude.js";
import { loginCase } from "./cases/login.js";
import type { Adapter } from "./adapters/types.js";
import type { EvalCase, Scorecard } from "./types.js";

const ADAPTERS: Record<string, Adapter> = { claude: claudeAdapter };
const CASES: EvalCase[] = [loginCase];

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const agentName = flag("agent") ?? "claude";
const caseFilter = flag("case");
const model = flag("model");

const adapter = ADAPTERS[agentName];
if (!adapter) {
  console.error(
    `Unknown agent "${agentName}". Available: ${Object.keys(ADAPTERS).join(", ")}`,
  );
  process.exit(1);
}
const cases = caseFilter ? CASES.filter((c) => c.name === caseFilter) : CASES;
if (cases.length === 0) {
  console.error(`No case named "${caseFilter}"`);
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

/** Throwaway agent workdir: bundled skill + MCP config, nothing else. */
function makeWorkdir(): { cwd: string; mcpConfigPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "sbm-eval-"));
  mkdirSync(join(cwd, ".claude", "skills"), { recursive: true });
  cpSync(
    join(repoRoot, "skills", "secure-browser"),
    join(cwd, ".claude", "skills", "secure-browser"),
    { recursive: true },
  );
  const mcpConfigPath = join(cwd, "mcp-config.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        "secure-browser": {
          command: "bun",
          args: ["run", join(repoRoot, "src", "index.ts")],
          env: {
            // Blank the Turnkey vars so the server picks the mock backend
            // even when the parent shell has real credentials exported.
            TURNKEY_API_PUBLIC_KEY: "",
            TURNKEY_API_PRIVATE_KEY: "",
            TURNKEY_ORGANIZATION_ID: "",
            SBM_HEADLESS: "1",
          },
        },
      },
    }),
  );
  return { cwd, mcpConfigPath };
}

let anyFail = false;
for (const evalCase of cases) {
  console.log(`\n=== ${evalCase.name} (${adapter.name}) ===`);
  const cleanup = await evalCase.setup();
  const { cwd, mcpConfigPath } = makeWorkdir();
  try {
    const run = await adapter.run({
      prompt: evalCase.prompt,
      mcpConfigPath,
      cwd,
      ...(model ? { model } : {}),
    });
    const graders = evalCase.grade(run);
    const perTool: Record<string, number> = {};
    for (const e of run.events) {
      const short = e.tool.replace(/^mcp__.*?__/, "");
      perTool[short] = (perTool[short] ?? 0) + 1;
    }
    const scorecard: Scorecard = {
      case: evalCase.name,
      agent: adapter.name,
      ...(model ? { model } : {}),
      pass: graders.every((g) => g.pass),
      graders,
      metrics: {
        toolCalls: run.events.length,
        toolErrors: run.events.filter((e) => e.isError).length,
        perTool,
      },
    };
    for (const g of graders) {
      console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
    }
    console.log(
      `  metrics: ${scorecard.metrics.toolCalls} tool calls ` +
        `(${scorecard.metrics.toolErrors} errors) ${JSON.stringify(perTool)}`,
    );
    const outPath = join(
      repoRoot,
      "evals",
      "results",
      `${evalCase.name}-${adapter.name}.json`,
    );
    writeFileSync(outPath, JSON.stringify(scorecard, null, 2) + "\n");
    console.log(`  scorecard: ${outPath}`);
    if (!scorecard.pass) anyFail = true;
  } finally {
    cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
}
process.exit(anyFail ? 1 : 0);
