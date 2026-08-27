/** Normalized shape every agent adapter reduces its transcript to. */
export type ToolCallEvent = {
  tool: string;
  args: Record<string, unknown>;
  /** Text of the tool result, as the agent saw it. */
  result: string;
  isError: boolean;
};

export type AdapterRun = {
  events: ToolCallEvent[];
  /** Everything the agent process emitted — the leak-scan surface. */
  rawTranscript: string;
  /** The agent's final answer to the user, if the harness can extract it. */
  finalText: string;
  exitCode: number;
};

export type AdapterOptions = {
  prompt: string;
  /** Path to a generated MCP config declaring the secure-browser server. */
  mcpConfigPath: string;
  cwd: string;
  model?: string;
};

export type Adapter = {
  name: string;
  run(opts: AdapterOptions): Promise<AdapterRun>;
};
