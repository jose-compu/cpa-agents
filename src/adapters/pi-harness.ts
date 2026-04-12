/**
 * Pi Harness adapter
 */

import { Channel } from "../channel.js";
import {
  type Process,
  type ProcessContext,
  type TraceEvent,
  par,
  branchFix,
} from "../process.js";
import { type AgentCall, agentProcess, codeThenFix } from "../agent.js";
import { Scheduler } from "../scheduler.js";

export function piTool<TInput, TOutput>(opts: {
  name: string;
  tool: string;
  buildArgs: (input: TInput) => Record<string, unknown>;
  parseResult: (raw: string) => TOutput;
}): AgentCall<TInput, TOutput> {
  return {
    name: `pi:${opts.name}`,
    invoke: async (_input: TInput, _signal: AbortSignal) => {
      throw new Error(
        `piTool(${opts.name}): RPC bridge not connected. ` +
          `Run Pi in RPC mode and configure the bridge.`
      );
    },
  };
}

export function piSubAgent<TOutput>(opts: {
  name: string;
  prompt: string;
  model?: string;
  parseResult: (sessionOutput: string) => TOutput;
}): AgentCall<void, TOutput> {
  return {
    name: `pi:subagent:${opts.name}`,
    invoke: async (_: void, _signal: AbortSignal) => {
      throw new Error(
        `piSubAgent(${opts.name}): sub-agent bridge not connected.`
      );
    },
  };
}

export function createPiCpaExtension() {
  return {
    name: "cpa-agents",
    version: "0.2.1",
    description: "Concurrent Process Algebra for AI agent orchestration",

    commands: {
      "cpa:par": {
        description: "Run tasks in parallel using process algebra",
        handler: async (args: string, piCtx: Record<string, any>) => {
          const tasks = args.split("|").map((t: string) => t.trim());
          const scheduler = new Scheduler({
            onTrace: (e: TraceEvent) => piCtx.log?.(`[cpa] ${e.type}: ${e.runId}`),
          });

          const processes = tasks.map((task: string) =>
            piSubAgent({
              name: task.slice(0, 30),
              prompt: task,
              parseResult: (out: string) => out,
            })
          );

          const parallelProc = par(
            ...processes.map((p) => agentProcess(p, undefined))
          );

          return scheduler.run("par", parallelProc);
        },
      },

      "cpa:fix": {
        description: "Run a task with automatic fix-on-error branching",
        handler: async (args: string, piCtx: Record<string, any>) => {
          const scheduler = new Scheduler({
            onTrace: (e: TraceEvent) => piCtx.log?.(`[cpa] ${e.type}: ${e.runId}`),
          });

          const coder: AgentCall<string, string> = {
            name: "coder",
            invoke: async (task: string, _signal: AbortSignal) => `// TODO: implement ${task}`,
          };

          const checker: AgentCall<string, { pass: boolean; errors: string[] }> = {
            name: "checker",
            invoke: async (_code: string, _signal: AbortSignal) => ({ pass: true, errors: [] }),
          };

          const fixer: AgentCall<{ code: string; errors: string[] }, string> = {
            name: "fixer",
            invoke: async (input: { code: string; errors: string[] }, _signal: AbortSignal) => input.code,
          };

          const proc = codeThenFix({ coder, checker, fixer, task: args });
          return scheduler.run("fix", proc);
        },
      },

      "cpa:tree": {
        description: "Display the CPA session tree",
        handler: async (_args: string, _piCtx: Record<string, any>) => {
          return { message: "Session tree display (see trace output)" };
        },
      },
    },
  };
}
