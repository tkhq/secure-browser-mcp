# Evals

Real headless agent runs against the MCP server, graded on the tool-call transcript. The point (issue #2): catch regressions in how well agents drive the tools, and prove the no-leak property holds under a real agent, not just a scripted client.

## Run

```sh
bun run eval                    # all cases, Claude Code, default model
bun run eval -- --case login    # one case
bun run eval -- --model haiku   # cheaper model
```

Requirements: `claude` CLI on PATH and logged in; a Chromium-family browser (same discovery as the server); port 4173 free.

Each case runs the agent in a throwaway directory containing only the bundled skill (`.claude/skills/secure-browser`) and an MCP config pointing at this repo's server with the **mock** secrets backend. So an eval run tests server, tools, and skill wording together — if the agent flails, fix the skill and re-run.

## What gets graded

Every case checks, from the normalized transcript:

- **no-leak** (hard fail): the mock secret value appears nowhere in anything the agent saw or emitted.
- **used-fill**: the agent filled the secret with `fill_secret`, not `type_text`.
- **completed**: the task actually finished (page state, not agent claims).

Plus recorded-only metrics — total tool calls, errors, per-tool counts — written to `evals/results/<case>-<agent>.json`. Compare that file across branches to spot regressions until CI wiring lands.

## Adding a case

Add `evals/cases/<name>.ts` exporting an `EvalCase` (`evals/types.ts`): a prompt, a `setup()` that starts any fixtures and returns a cleanup fn, and `grade(run)` over the normalized `AdapterRun`. Register it in `CASES` in `run.ts`.

## Adding an agent

Implement `Adapter` (`evals/adapters/types.ts`): spawn the agent's headless mode with the MCP config, normalize its transcript into `ToolCallEvent`s, and return everything it emitted as `rawTranscript` (the leak-scan surface). Register in `ADAPTERS` in `run.ts`.

Planned follow-ups, not yet implemented:

- **Codex**: `codex exec --json` with `-c mcp_servers.secure-browser.command=...`; skill goes in `~/.codex/skills/` (no project-scoped skills dir yet).
- **Gemini CLI**: not installed here; supports skills and MCP config per gemini.google.com docs.
- CI: run the suite on PRs with a repo API-key secret once the harness is stable.
