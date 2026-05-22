/**
 * Pi Harness adapter
 */

import {
  type Process,
  type ProcessContext,
  type TraceEvent,
  type SessionNode,
  par,
  branchFix,
} from "../process.js";
import { type AgentCall, agentProcess, fanOut } from "../agent.js";
import { invertible, or, retryWithBackoff, saga, timeout } from "../operators.js";
import { Scheduler, type SchedulerResult } from "../scheduler.js";
import { sessionTreeToMarkdown } from "../session-tree.js";
import { VERSION } from "../version.js";

export interface PiAgentRuntime {
  run: (
    task: string,
    opts?: { signal?: AbortSignal; model?: string }
  ) => Promise<{ output: string; errors?: string[] }>;
  runTool?: (
    tool: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<string>;
}

export interface PiHostContext {
  log?: (msg: string) => void;
  session?: {
    id: string;
    appendEvent?: (event: TraceEvent) => void;
  };
  agent?: PiAgentRuntime;
}

export interface PiBridge {
  runSubAgent: (
    opts: { prompt: string; model?: string },
    signal: AbortSignal
  ) => Promise<string>;
  runTool: (
    opts: { tool: string; args: Record<string, unknown> },
    signal: AbortSignal
  ) => Promise<string>;
}

let configuredPiBridge: PiBridge | undefined;

/** Connect standalone piTool/piSubAgent factories to a host runtime. */
export function configurePiBridge(bridge: PiBridge | undefined): void {
  configuredPiBridge = bridge;
}

function resolvePiBridge(explicit?: PiBridge): PiBridge {
  const bridge = explicit ?? configuredPiBridge;
  if (!bridge) {
    throw new Error(
      "Pi bridge not connected. Pass bridge to the factory, call configurePiBridge(), " +
        "or use createPiCpaExtension() with piCtx.agent."
    );
  }
  return bridge;
}

function requirePiAgent(ctx: PiHostContext): PiAgentRuntime {
  if (!ctx.agent) {
    throw new Error(
      "Pi agent runtime not connected. Provide piCtx.agent with a run() method."
    );
  }
  return ctx.agent;
}

function sessionId(ctx: PiHostContext): string {
  return ctx.session?.id ?? "default";
}

function makeScheduler(ctx: PiHostContext) {
  return new Scheduler({
    onTrace: (e: TraceEvent) => {
      ctx.log?.(`[cpa] ${e.type}: ${e.runId}`);
      ctx.session?.appendEvent?.(e);
    },
  });
}

function makeRunTask(agent: PiAgentRuntime) {
  return (task: string, model?: string): Process<string> =>
    async (runCtx: ProcessContext) => {
      const result = await agent.run(task, {
        model,
        signal: runCtx.signal,
      });
      if (result.errors?.length) {
        throw new Error(result.errors.join("; "));
      }
      return result.output;
    };
}

function makeRunTaskVoid(agent: PiAgentRuntime) {
  const runTask = makeRunTask(agent);
  return (task: string, model?: string): Process<void> =>
    async (runCtx: ProcessContext) => {
      await runTask(task, model)(runCtx);
    };
}

export function piTool<TInput, TOutput>(opts: {
  name: string;
  tool: string;
  buildArgs: (input: TInput) => Record<string, unknown>;
  parseResult: (raw: string) => TOutput;
  bridge?: PiBridge;
}): AgentCall<TInput, TOutput> {
  return {
    name: `pi:${opts.name}`,
    invoke: async (input: TInput, signal: AbortSignal) => {
      const bridge = resolvePiBridge(opts.bridge);
      const raw = await bridge.runTool(
        { tool: opts.tool, args: opts.buildArgs(input) },
        signal
      );
      return opts.parseResult(raw);
    },
  };
}

export function piSubAgent<TOutput>(opts: {
  name: string;
  prompt: string;
  model?: string;
  parseResult: (sessionOutput: string) => TOutput;
  bridge?: PiBridge;
}): AgentCall<void, TOutput> {
  return {
    name: `pi:subagent:${opts.name}`,
    invoke: async (_: void, signal: AbortSignal) => {
      const bridge = resolvePiBridge(opts.bridge);
      const output = await bridge.runSubAgent(
        { prompt: opts.prompt, model: opts.model },
        signal
      );
      return opts.parseResult(output);
    },
  };
}

export function createPiBridgeFromAgent(agent: PiAgentRuntime): PiBridge {
  return {
    runSubAgent: async ({ prompt, model }, signal) => {
      const result = await agent.run(prompt, { model, signal });
      if (result.errors?.length) {
        throw new Error(result.errors.join("; "));
      }
      return result.output;
    },
    runTool: async ({ tool, args }, signal) => {
      if (!agent.runTool) {
        throw new Error(`Pi agent runtime has no runTool() for tool "${tool}"`);
      }
      return agent.runTool(tool, args, { signal });
    },
  };
}

export function createPiCpaExtension() {
  const lastTrees = new Map<string, SessionNode[]>();

  async function rememberTree(
    ctx: PiHostContext,
    result: SchedulerResult<unknown>
  ) {
    lastTrees.set(sessionId(ctx), result.sessionTree);
    return result;
  }

  return {
    name: "cpa-agents",
    version: VERSION,
    description: "Concurrent Process Algebra for AI agent orchestration",

    commands: {
      "cpa:par": {
        description: "Run tasks in parallel using process algebra",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);
          const tasks = args
            .split("|")
            .map((t: string) => t.trim())
            .filter(Boolean);

          const runTask = makeRunTask(agent);
          const processes = tasks.map((task: string) => runTask(task));

          return rememberTree(
            piCtx,
            await scheduler.run("par", par(...processes))
          );
        },
      },

      "cpa:fix": {
        description: "Run a task with automatic fix-on-error branching",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);
          const task = args.trim();

          const proc = branchFix<string>({
            name: "pi-fix",
            main: (requestFix) => async (ctx: ProcessContext) => {
              const result = await agent.run(task, { signal: ctx.signal });
              if (result.errors?.length) {
                await requestFix(result.errors.join("; "));
              }
              return result.output;
            },
            fix: (reason: string) => async (ctx: ProcessContext) => {
              await agent.run(`Fix the following issues: ${reason}`, {
                signal: ctx.signal,
              });
            },
          });

          return rememberTree(piCtx, await scheduler.run("fix", proc));
        },
      },

      "cpa:tree": {
        description: "Display the CPA session tree",
        handler: async (_args: string, piCtx: PiHostContext) => {
          const tree = lastTrees.get(sessionId(piCtx)) ?? [];
          return {
            tree,
            markdown: sessionTreeToMarkdown(tree),
          };
        },
      },

      "cpa:retry": {
        description: "Retry a Pi task with backoff and timeout",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);
          const task = args.trim();
          const runTask = makeRunTask(agent);

          const proc = retryWithBackoff({
            process: timeout(30_000, runTask(task)),
            maxAttempts: 3,
            initialDelayMs: 100,
          });

          return rememberTree(piCtx, await scheduler.run("retry", proc));
        },
      },

      "cpa:fallback": {
        description: "Run fallback Pi task if primary fails",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);

          const [primary, fallback] = args
            .split("||")
            .map((part: string) => part.trim())
            .filter(Boolean);

          const primaryPrompt = primary ?? args.trim();
          const fallbackPrompt = fallback ?? `Fallback for: ${primaryPrompt}`;
          const runTask = makeRunTask(agent);

          const proc: Process<string> = async (ctx: ProcessContext) => {
            const result = await or(
              runTask(primaryPrompt),
              runTask(fallbackPrompt)
            )(ctx);
            if (!result.ok) {
              throw result.error;
            }
            return result.value;
          };

          return rememberTree(piCtx, await scheduler.run("fallback", proc));
        },
      },

      "cpa:saga": {
        description: "Run rollback-aware multi-step Pi workflow",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);
          const runTask = makeRunTask(agent);
          const runTaskVoid = makeRunTaskVoid(agent);

          const steps = args
            .split("|")
            .map((part: string) => part.trim())
            .filter(Boolean);

          const proc = saga(
            steps.map((step) =>
              invertible(
                runTask(step),
                () =>
                  runTaskVoid(`Rollback/undo the effects of this step: ${step}`)
              )
            )
          );

          return rememberTree(piCtx, await scheduler.run("saga", proc));
        },
      },

      "cpa:fan-out": {
        description: "Run the same task across multiple Pi models",
        handler: async (args: string, piCtx: PiHostContext) => {
          const agent = requirePiAgent(piCtx);
          const scheduler = makeScheduler(piCtx);

          const [taskPart, modelsPart] = args.split("::").map((s) => s.trim());
          const task = taskPart || args.trim();
          const models = modelsPart
            ? modelsPart.split(",").map((m) => m.trim()).filter(Boolean)
            : [undefined];

          const agents: AgentCall<string, string>[] = models.map((model) => ({
            name: model ? `model:${model}` : "model:default",
            invoke: async (input: string, signal: AbortSignal) => {
              const result = await agent.run(input, { model, signal });
              if (result.errors?.length) {
                throw new Error(result.errors.join("; "));
              }
              return result.output;
            },
          }));

          const proc = fanOut({
            agents,
            input: task,
            merge: (results: string[]) => ({ results, count: results.length }),
          });

          return rememberTree(piCtx, await scheduler.run("fan-out", proc));
        },
      },
    },
  };
}
