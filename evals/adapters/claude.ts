/**
 * Claude Code adapter: runs `claude -p` headless with the secure-browser MCP
 * server and the bundled skill, and normalizes the stream-json transcript
 * into ToolCallEvents.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Adapter, AdapterRun, ToolCallEvent } from "./types.js";

/** MCP tools are namespaced mcp__<server-key>__<tool>. */
const TOOL_PREFIX = "mcp__secure-browser__";

// The slices of Claude Code's stream-json output the harness consumes.
// Unknown block types fall out of the discriminated union and are skipped.
const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()).default({}),
});
const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z
    .union([z.string(), z.array(z.object({ text: z.string().optional() }))])
    .optional(),
});
const streamLine = z.object({
  type: z.string(),
  result: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()).default([]) }).optional(),
});

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
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = streamLine.safeParse(json);
      if (!parsed.success) continue;
      const msg = parsed.data;
      for (const rawBlock of msg.message?.content ?? []) {
        if (msg.type === "assistant") {
          const use = toolUseBlock.safeParse(rawBlock);
          if (use.success) {
            const event: ToolCallEvent = {
              tool: use.data.name,
              args: use.data.input,
              result: "",
              isError: false,
            };
            useById.set(use.data.id, event);
            events.push(event);
          }
        }
        if (msg.type === "user") {
          const res = toolResultBlock.safeParse(rawBlock);
          if (!res.success) continue;
          const event = useById.get(res.data.tool_use_id);
          if (!event) continue;
          event.isError = res.data.is_error === true;
          event.result =
            typeof res.data.content === "string"
              ? res.data.content
              : (res.data.content ?? []).map((c) => c.text ?? "").join("\n");
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
