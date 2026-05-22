/**
 * AgentProcess: bridges the process algebra to actual LLM agent calls.
 *
 * An AgentProcess wraps an LLM invocation (tool use loop, ReAct step,
 * or sub-agent spawn) as a Process<T> that can be composed with
 * all the algebra combinators.
 */

import { Channel } from "./channel.js";
import { type Process, type ProcessContext, branchFix, par, seq } from "./process.js";

// ─── Agent abstraction ──────────────────────────────────────────

export interface AgentCall<TInput, TOutput> {
  /** Human-readable name for traces */
  name: string;
  /** The actual agent invocation */
  invoke: (input: TInput, signal: AbortSignal) => Promise<TOutput>;
}

/**
 * Lift an agent call into a Process.
 */
export function agentProcess<TInput, TOutput>(
  agent: AgentCall<TInput, TOutput>,
  input: TInput
): Process<TOutput> {
  return async (ctx) => {
    ctx.trace.emit({
      type: "spawn",
      runId: ctx.runId,
      parentId: ctx.parentId,
      name: agent.name,
      ts: Date.now(),
    });

    const result = await agent.invoke(input, ctx.signal);

    ctx.trace.emit({
      type: "done",
      runId: ctx.runId,
      ts: Date.now(),
    });

    return result;
  };
}

// ─── Common agent workflow patterns ─────────────────────────────

/**
 * Code-then-fix: the tree pattern from Pi Harness.
 *
 * 1. Agent writes code
 * 2. Lint/test/typecheck runs
 * 3. If errors found → branch to fix agent → re-check → continue
 * 4. If clean → proceed to next task
 */
export function codeThenFix<TCode>(opts: {
  coder: AgentCall<string, TCode>;
  checker: AgentCall<TCode, CheckResult>;
  fixer: AgentCall<{ code: TCode; errors: string[] }, TCode>;
  task: string;
  maxFixes?: number;
}): Process<TCode> {
  return branchFix<TCode>({
    name: `code_fix_${opts.task.slice(0, 20)}`,
    maxFixes: opts.maxFixes,

    main: (requestFix) => async (ctx) => {
      // Step 1: generate code
      let code = await opts.coder.invoke(opts.task, ctx.signal);

      // Step 2: check it
      let checkResult = await opts.checker.invoke(code, ctx.signal);

      // Step 3: loop fix if needed
      while (!checkResult.pass) {
        await requestFix(checkResult.errors.join("; "));
        code = await opts.fixer.invoke(
          { code, errors: checkResult.errors },
          ctx.signal
        );
        checkResult = await opts.checker.invoke(code, ctx.signal);
      }

      return code;
    },

    fix: (reason) => async (ctx) => {
      ctx.trace.emit({
        type: "fix_start",
        runId: ctx.runId,
        reason,
        ts: Date.now(),
      });
      // The actual fix work happens in the main loop above.
      // This hook is for side effects: logging, notifying, etc.
      ctx.trace.emit({
        type: "fix_end",
        runId: ctx.runId,
        success: true,
        ts: Date.now(),
      });
    },
  });
}

export interface CheckResult {
  pass: boolean;
  errors: string[];
}

/**
 * Fan-out pattern: send the same task to N agents in parallel,
 * collect results, then merge.
 *
 * Useful for: parallel research, multi-model consensus, ensemble.
 */
export function fanOut<TInput, TOutput, TMerged>(opts: {
  agents: AgentCall<TInput, TOutput>[];
  input: TInput;
  merge: (results: TOutput[]) => TMerged;
}): Process<TMerged> {
  const processes = opts.agents.map((agent) =>
    agentProcess(agent, opts.input)
  );

  return async (ctx) => {
    const results = await par(...processes)(ctx);
    return opts.merge(results as TOutput[]);
  };
}

/**
 * Pipeline: chain agents sequentially where each output feeds the next.
 */
export function pipeline<A, B>(
  a: AgentCall<A, B>,
  inputA: A
): PipelineBuilder<A, B>;
export function pipeline<A, B>(
  a: AgentCall<A, B>,
  inputA: A
): PipelineBuilder<A, B> {
  return new PipelineBuilder(a, inputA);
}

export class PipelineBuilder<TFirst, TLast> {
  private steps: Array<{ agent: AgentCall<any, any>; inputFn?: (prev: any) => any }> = [];
  private firstAgent: AgentCall<TFirst, any>;
  private firstInput: TFirst;

  constructor(agent: AgentCall<TFirst, any>, input: TFirst) {
    this.firstAgent = agent;
    this.firstInput = input;
  }

  then<TNext>(
    agent: AgentCall<TLast, TNext>,
    transform?: (prev: TLast) => TLast
  ): PipelineBuilder<TFirst, TNext> {
    this.steps.push({ agent, inputFn: transform });
    return this as unknown as PipelineBuilder<TFirst, TNext>;
  }

  build(): Process<TLast> {
    const { firstAgent, firstInput, steps } = this;

    return async (ctx) => {
      let result: any = await firstAgent.invoke(firstInput, ctx.signal);

      for (const step of steps) {
        const input = step.inputFn ? step.inputFn(result) : result;
        result = await step.agent.invoke(input, ctx.signal);
      }

      return result as TLast;
    };
  }
}

/**
 * Handoff: one agent works, then hands off to another via a channel.
 * Models the Pi Harness pattern of sub-agent spawning.
 */
export function handoff<THandoff>(opts: {
  from: AgentCall<void, THandoff>;
  to: AgentCall<THandoff, void>;
}): Process<void> {
  return async (ctx) => {
    await Channel.restrict<THandoff, void>("handoff", async (ch) => {
      await par(
        // Producer: runs `from`, sends result on channel
        async (pCtx) => {
          const result = await opts.from.invoke(undefined, pCtx.signal);
          pCtx.trace.emit({
            type: "send",
            runId: pCtx.runId,
            channel: ch.name,
            ts: Date.now(),
          });
          await ch.send(result, pCtx.signal);
        },
        // Consumer: receives from channel, runs `to`
        async (cCtx) => {
          const value = await ch.receive(cCtx.signal);
          cCtx.trace.emit({
            type: "receive",
            runId: cCtx.runId,
            channel: ch.name,
            ts: Date.now(),
          });
          await opts.to.invoke(value, cCtx.signal);
        }
      )(ctx);
    });
  };
}
