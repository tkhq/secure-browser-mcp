/**
 * Claude Code adapter: runs `claude -p` headless with the secure-browser MCP
 * server and the bundled skill, and normalizes the stream-json transcript
 * into ToolCallEvents.
 */
import { spawn } from "node:child_process";
import type { Adapter, AdapterRun, ToolCallEvent } from "./types.js";

/** MCP tools are namespaced mcp__<server-key>__<tool>. */
const TOOL_PREFIX = "mcp__secure-browser__";

export const claudeAdapter: Adapter = {
  name: "claude",
  async run({ prompt, mcpConfigPath, cwd, model }): Promise<AdapterRun> {
    const args = [
      "-p",
      prompt,
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      // Auto-approve only the broker's tools (plus Skill, so the bundled
      // skill can activate). Everything else is denied in print mode.
      "--allowedTools",
      `${TOOL_PREFIX}* Skill`,
      "--max-turns",
      "40",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (model) args.push("--model", model);

    const child = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_AUTOUPDATE: "0" },
    });

    let rawTranscript = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (rawTranscript += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const exitCode: number = await new Promise((resolve) =>
      child.on("close", (code) => resolve(code ?? 1)),
    );

    // stream-json: one JSON object per line. tool_use lives in assistant
    // messages, tool_result in user messages (linked by tool_use_id).
    const useById = new Map<string, ToolCallEvent>();
    const events: ToolCallEvent[] = [];
    let finalText = "";
    for (const line of rawTranscript.split("\n")) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      for (const block of msg?.message?.content ?? []) {
        if (msg.type === "assistant" && block.type === "tool_use") {
          const event: ToolCallEvent = {
            tool: block.name,
            args: block.input ?? {},
            result: "",
            isError: false,
          };
          useById.set(block.id, event);
          events.push(event);
        }
        if (msg.type === "user" && block.type === "tool_result") {
          const event = useById.get(block.tool_use_id);
          if (!event) continue;
          event.isError = block.is_error === true;
          event.result =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? []).map((c: any) => c.text ?? "").join("\n");
        }
      }
      if (msg.type === "result") finalText = msg.result ?? "";
    }

    if (exitCode !== 0 && events.length === 0) {
      console.error(`claude exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    return {
      events,
      rawTranscript: rawTranscript + stderr,
      finalText,
      exitCode,
    };
  },
};

export { TOOL_PREFIX };
