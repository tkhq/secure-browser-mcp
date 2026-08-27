import type { AdapterRun } from "./adapters/types.js";

export type GraderResult = { name: string; pass: boolean; detail: string };

export type EvalCase = {
  name: string;
  prompt: string;
  /** Start whatever the case needs (fixture servers); returns a cleanup fn. */
  setup(): Promise<() => void>;
  grade(run: AdapterRun): GraderResult[];
};

export type Scorecard = {
  case: string;
  agent: string;
  model?: string;
  pass: boolean;
  graders: GraderResult[];
  metrics: {
    toolCalls: number;
    toolErrors: number;
    perTool: Record<string, number>;
  };
};
