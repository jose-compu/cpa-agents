/**
 * OpenClaw adapter
 *
 * Integrates cpa-agents as an OpenClaw skill.
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

export { sessionTreeToMarkdown };

// ─── SKILL.md content ───────────────────────────────────────────

export const SKILL_MD = `# cpa-agents — Concurrent Process Algebra

Use process algebra primitives to orchestrate agent workflows in OpenClaw.
This skill is useful for parallel execution, branch-fix loops, fan-out
comparison, and inspecting workflow state.

## Install

### 1) Install library
\`\`\`bash
npm install cpa-agents
\`\`\`

### 2) Create the skill entrypoint
\`\`\`ts
import { createOpenClawSkill } from "cpa-agents/adapters/openclaw";

export default createOpenClawSkill();
\`\`\`

### 3) Ensure OpenClaw can execute skills
- OpenClaw Gateway must be running.
- Your skill runtime must allow async tool execution.
- Keep this package at version \`${VERSION}\` or newer.

## Commands

### cpa:parallel
Run independent tasks concurrently.

Input:
\`\`\`json
{ "tasks": ["task one", "task two"], "timeout": 300000 }
\`\`\`

### cpa:branch-fix
Run task, detect errors, branch into a fix subprocess, then continue.

Input:
\`\`\`json
{ "task": "implement feature with checks", "timeout": 300000 }
\`\`\`

### cpa:fan-out
Run same task across multiple models and return merged results.

Input:
\`\`\`json
{ "task": "draft API design", "models": ["model-a", "model-b"], "timeout": 300000 }
\`\`\`

### cpa:retry
Retry a task with exponential backoff and per-attempt timeout.

Input:
\`\`\`json
{ "task": "fix flaky test", "maxAttempts": 3, "initialDelayMs": 250, "stepTimeout": 60000 }
\`\`\`

### cpa:fallback
Run fallback task if primary task fails.

Input:
\`\`\`json
{ "primary": "run strict analyzer", "fallback": "run lightweight analyzer" }
\`\`\`

### cpa:saga
Run multiple steps with rollback compensation on failure.

Input:
\`\`\`json
{ "steps": ["create branch", "apply patch", "run validation"] }
\`\`\`

### cpa:status
Get current process tree/status for the current session.

Input:
\`\`\`json
{}
\`\`\`

## Recommended usage prompts

- "Run in parallel: analyze bug, propose fix, generate tests"
- "Branch-fix this refactor until no type errors remain"
- "Fan-out this architecture prompt across 2 models and compare"
- "Show cpa status"

## Troubleshooting

- **Gateway not connected**
  - Start OpenClaw Gateway and retry.
- **Unknown command**
  - Use one of: \`parallel\`, \`branch-fix\`, \`fan-out\`, \`retry\`, \`fallback\`, \`saga\`, \`status\`.
- **Timeout errors**
  - Increase \`timeout\` in command args.
- **No session events**
  - Confirm session context has \`appendEvent\` enabled.
`;

// ─── OpenClaw tool wrappers ─────────────────────────────────────

export interface OpenClawBridge {
  runTool: (
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<unknown>;
  readMemory: (key: string, signal?: AbortSignal) => Promise<string>;
  writeMemory: (
    input: { key: string; value: string },
    signal?: AbortSignal
  ) => Promise<void>;
}

let configuredOpenClawBridge: OpenClawBridge | undefined;

/** Connect standalone openclawTool/workspaceAgent factories to a gateway. */
export function configureOpenClawBridge(
  bridge: OpenClawBridge | undefined
): void {
  configuredOpenClawBridge = bridge;
}

function resolveOpenClawBridge(explicit?: OpenClawBridge): OpenClawBridge {
  const bridge = explicit ?? configuredOpenClawBridge;
  if (!bridge) {
    throw new Error(
      "OpenClaw bridge not connected. Pass bridge to the factory, call configureOpenClawBridge(), " +
        "or use createOpenClawSkill() with openclawCtx.agent."
    );
  }
  return bridge;
}

export function openclawTool<TInput, TOutput>(opts: {
  name: string;
  tool: string;
  buildArgs: (input: TInput) => Record<string, unknown>;
  parseResult: (raw: unknown) => TOutput;
  bridge?: OpenClawBridge;
}): AgentCall<TInput, TOutput> {
  return {
    name: `openclaw:${opts.name}`,
    invoke: async (input: TInput, signal: AbortSignal): Promise<TOutput> => {
      const bridge = resolveOpenClawBridge(opts.bridge);
      const raw = await bridge.runTool(
        opts.tool,
        opts.buildArgs(input),
        signal
      );
      return opts.parseResult(raw);
    },
  };
}

export function workspaceAgent(opts: {
  name: string;
  workspacePath?: string;
  bridge?: OpenClawBridge;
}): {
  readMemory: AgentCall<string, string>;
  writeMemory: AgentCall<{ key: string; value: string }, void>;
} {
  const getBridge = () => resolveOpenClawBridge(opts.bridge);

  return {
    readMemory: {
      name: `workspace:read:${opts.name}`,
      invoke: async (key: string, signal: AbortSignal): Promise<string> => {
        return getBridge().readMemory(key, signal);
      },
    },
    writeMemory: {
      name: `workspace:write:${opts.name}`,
      invoke: async (
        input: { key: string; value: string },
        signal: AbortSignal
      ): Promise<void> => {
        await getBridge().writeMemory(input, signal);
      },
    },
  };
}

// ─── OpenClaw skill handler ─────────────────────────────────────

interface OpenClawContext {
  session?: {
    id: string;
    appendEvent?: (event: TraceEvent) => void;
  };
  agent: {
    run: (
      task: string,
      opts?: { signal?: AbortSignal; model?: string }
    ) => Promise<{ output: string; errors?: string[] }>;
  };
}

export function createOpenClawSkill() {
  const schedulers = new Map<string, Scheduler>();

  return {
    name: "cpa-agents",
    version: VERSION,
    skillMd: SKILL_MD,

    async handleCommand(
      command: string,
      args: Record<string, unknown>,
      openclawCtx: OpenClawContext
    ): Promise<SchedulerResult<unknown>> {
      const scheduler = new Scheduler({
        timeout: (args.timeout as number) ?? 300_000,
        onTrace: (e: TraceEvent) => {
          openclawCtx.session?.appendEvent?.(e);
        },
      });

      const sessionId = openclawCtx.session?.id ?? "unknown";
      schedulers.set(sessionId, scheduler);

      try {
        const runTask =
          (task: string, model?: string): Process<string> =>
          async (ctx: ProcessContext) => {
            const result = await openclawCtx.agent.run(task, {
              model,
              signal: ctx.signal,
            });
            if (result.errors?.length) {
              throw new Error(result.errors.join("; "));
            }
            return result.output;
          };

        const runTaskVoid =
          (task: string, model?: string): Process<void> =>
          async (ctx: ProcessContext) => {
            await runTask(task, model)(ctx);
          };

        switch (command) {
          case "parallel": {
            const tasks = args.tasks as string[];
            const processes = tasks.map((task: string) =>
              agentProcess<void, { output: string }>(
                {
                  name: task.slice(0, 30),
                  invoke: async (_: void, signal: AbortSignal) => {
                    return openclawCtx.agent.run(task, { signal });
                  },
                },
                undefined
              )
            );

            return scheduler.run("parallel", par(...processes));
          }

          case "branch-fix": {
            const task = args.task as string;
            const proc = branchFix<string>({
              name: "openclaw-fix",
              main: (requestFix) => async (ctx: ProcessContext) => {
                const result = await openclawCtx.agent.run(task, {
                  signal: ctx.signal,
                });

                if (result.errors?.length) {
                  await requestFix(result.errors.join("; "));
                }

                return result.output;
              },
              fix: (reason: string) => async (ctx: ProcessContext) => {
                await openclawCtx.agent.run(
                  `Fix the following issues: ${reason}`,
                  { signal: ctx.signal }
                );
              },
            });

            return scheduler.run("branch-fix", proc);
          }

          case "fan-out": {
            const task = args.task as string;
            const models = (args.models as string[]) ?? [
              "claude-sonnet-4-20250514",
              "gpt-4o",
            ];

            const agents: AgentCall<string, string>[] = models.map(
              (model: string) => ({
                name: `model:${model}`,
                invoke: async (input: string, signal: AbortSignal) => {
                  const result = await openclawCtx.agent.run(input, {
                    model,
                    signal,
                  });
                  return result.output;
                },
              })
            );

            const proc = fanOut({
              agents,
              input: task,
              merge: (results: string[]) => ({
                results,
                consensus: results.length,
              }),
            });

            return scheduler.run("fan-out", proc);
          }

          case "retry": {
            const task = args.task as string;
            const model = args.model as string | undefined;
            const maxAttempts = (args.maxAttempts as number) ?? 3;
            const initialDelayMs = (args.initialDelayMs as number) ?? 250;
            const stepTimeout = (args.stepTimeout as number) ?? 60_000;

            const proc = retryWithBackoff({
              process: timeout(stepTimeout, runTask(task, model)),
              maxAttempts,
              initialDelayMs,
            });

            return scheduler.run("retry", proc);
          }

          case "fallback": {
            const primary = args.primary as string;
            const fallback = args.fallback as string;
            const model = args.model as string | undefined;

            const proc: Process<string> = async (ctx: ProcessContext) => {
              const result = await or(
                runTask(primary, model),
                runTask(fallback, model)
              )(ctx);
              if (!result.ok) {
                throw result.error;
              }
              return result.value;
            };

            return scheduler.run("fallback", proc);
          }

          case "saga": {
            const steps = (args.steps as string[]) ?? [];
            const model = args.model as string | undefined;

            const proc = saga(
              steps.map((step) =>
                invertible(
                  runTask(step, model),
                  () =>
                    runTaskVoid(
                      `Rollback/undo the effects of this step: ${step}`,
                      model
                    )
                )
              )
            );

            return scheduler.run("saga", proc);
          }

          case "status": {
            const s = schedulers.get(sessionId);
            if (!s) {
              return {
                success: true,
                value: { message: "No active CPA processes" },
                trace: scheduler.traceCollector,
                sessionTree: [],
              };
            }
            return {
              success: true,
              value: { tree: s.getSessionTree() },
              trace: s.traceCollector,
              sessionTree: s.getSessionTree(),
            };
          }

          default:
            throw new Error(`Unknown CPA command: ${command}`);
        }
      } finally {
        schedulers.delete(sessionId);
      }
    },
  };
}

