/**
 * OpenClaw adapter
 *
 * Integrates cpa-agents as an OpenClaw skill.
 */

import { Channel } from "../channel.js";
import {
  type Process,
  type ProcessContext,
  type TraceEvent,
  type SessionNode,
  par,
  branchFix,
} from "../process.js";
import { type AgentCall, agentProcess, fanOut } from "../agent.js";
import { Scheduler, type SchedulerResult } from "../scheduler.js";

// ─── SKILL.md content ───────────────────────────────────────────

export const SKILL_MD = `# cpa-agents — Concurrent Process Algebra

Orchestrate complex multi-step agent workflows using formal
process algebra primitives. Supports parallel execution,
branch-fix-continue patterns, and supervised error recovery.

## Commands

- \`cpa:parallel\` — Run multiple tasks concurrently
- \`cpa:pipeline\` — Chain tasks sequentially
- \`cpa:branch-fix\` — Run a task with automatic error correction branching
- \`cpa:fan-out\` — Send same task to multiple models, merge results
- \`cpa:status\` — Show running process tree

## When to use

Use this skill when:
- You need to run multiple independent tasks at the same time
- A task might fail and needs automatic retry/fix before continuing
- You want to compare outputs from different approaches
- Complex workflows with dependencies between steps
`;

// ─── OpenClaw tool wrappers ─────────────────────────────────────

export function openclawTool<TInput, TOutput>(opts: {
  name: string;
  tool: string;
  buildArgs: (input: TInput) => Record<string, unknown>;
  parseResult: (raw: unknown) => TOutput;
}): AgentCall<TInput, TOutput> {
  return {
    name: `openclaw:${opts.name}`,
    invoke: async (_input: TInput, _signal: AbortSignal): Promise<TOutput> => {
      throw new Error(
        `openclawTool(${opts.name}): Gateway not connected. ` +
          `Ensure OpenClaw Gateway is running on ws://127.0.0.1:18789`
      );
    },
  };
}

export function workspaceAgent(opts: {
  name: string;
  workspacePath?: string;
}): {
  readMemory: AgentCall<string, string>;
  writeMemory: AgentCall<{ key: string; value: string }, void>;
} {
  return {
    readMemory: {
      name: `workspace:read:${opts.name}`,
      invoke: async (_key: string, _signal: AbortSignal): Promise<string> => {
        throw new Error("Workspace bridge not connected");
      },
    },
    writeMemory: {
      name: `workspace:write:${opts.name}`,
      invoke: async (
        _input: { key: string; value: string },
        _signal: AbortSignal
      ): Promise<void> => {
        throw new Error("Workspace bridge not connected");
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
    version: "0.1.0",
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

          case "status": {
            const s = schedulers.get(sessionId);
            if (!s) {
              return {
                success: true,
                value: { message: "No active CPA processes" },
                trace: scheduler["trace"],
                sessionTree: [],
              };
            }
            return {
              success: true,
              value: { tree: s.getSessionTree() },
              trace: s["trace"],
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

// ─── Session tree serialization ─────────────────────────────────

export function sessionTreeToMarkdown(
  nodes: SessionNode[],
  depth = 0
): string {
  const indent = "  ".repeat(depth);
  let md = "";

  for (const node of nodes) {
    const status = node.events.some((e: TraceEvent) => e.type === "error")
      ? "error"
      : node.events.some((e: TraceEvent) => e.type === "done")
        ? "done"
        : "running";

    md += `${indent}- **${node.name}** (${node.runId}) [${status}]\n`;

    const branches = node.events.filter(
      (e: TraceEvent) => e.type === "branch"
    );
    for (const b of branches) {
      if (b.type === "branch") {
        md += `${indent}  - Branch: chose "${b.chosen}" from [${b.alternatives.join(", ")}]\n`;
      }
    }

    const fixes = node.events.filter(
      (e: TraceEvent) =>
        e.type === "fix_start" || e.type === "fix_end"
    );
    for (const f of fixes) {
      if (f.type === "fix_start") {
        md += `${indent}  - Fix started: ${f.reason}\n`;
      }
    }

    if (node.children.length > 0) {
      md += sessionTreeToMarkdown(node.children, depth + 1);
    }
  }

  return md;
}
