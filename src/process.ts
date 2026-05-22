/**
 * Process: the core unit of computation in the algebra.
 *
 * A Process is a function that takes a context (channels, signals)
 * and returns a result. Processes compose via parallel, sequential,
 * choice, and branch-fix-continue combinators.
 */

import { Channel, ChannelId, freshId, select, type SelectCase } from "./channel.js";

// ─── Process types ──────────────────────────────────────────────

export interface ProcessContext {
  /** Unique run ID for this process instance */
  readonly runId: string;
  /** Parent process ID, if spawned as a child */
  readonly parentId?: string;
  /** Abort signal — checked by cooperative processes */
  readonly signal: AbortSignal;
  /** Trace collector for session tree */
  readonly trace: TraceCollector;
  /** Named channels available in scope */
  readonly channels: Map<string, Channel<any>>;
}

export type Process<T = void> = (ctx: ProcessContext) => Promise<T>;

// ─── Trace (session tree support) ───────────────────────────────

export type TraceEvent =
  | { type: "spawn"; runId: string; parentId?: string; name: string; ts: number }
  | { type: "send"; runId: string; channel: string; ts: number }
  | { type: "receive"; runId: string; channel: string; ts: number }
  | { type: "branch"; runId: string; chosen: string; alternatives: string[]; ts: number }
  | { type: "fix_start"; runId: string; reason: string; ts: number }
  | { type: "fix_end"; runId: string; success: boolean; ts: number }
  | { type: "done"; runId: string; ts: number }
  | { type: "error"; runId: string; error: string; ts: number };

export class TraceCollector {
  readonly events: TraceEvent[] = [];

  emit(event: TraceEvent): void {
    this.events.push(event);
  }

  /** Get a serialisable session tree from the flat event log */
  toTree(): SessionNode[] {
    const nodes = new Map<string, SessionNode>();
    const roots: SessionNode[] = [];

    for (const e of this.events) {
      if (e.type === "spawn") {
        const node: SessionNode = {
          runId: e.runId,
          name: e.name,
          parentId: e.parentId,
          events: [],
          children: [],
        };
        nodes.set(e.runId, node);
        if (e.parentId && nodes.has(e.parentId)) {
          nodes.get(e.parentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }

      const node = nodes.get(e.runId);
      if (node) {
        node.events.push(e);
      }
    }

    return roots;
  }
}

export interface SessionNode {
  runId: string;
  name: string;
  parentId?: string;
  events: TraceEvent[];
  children: SessionNode[];
}

// ─── Combinators ────────────────────────────────────────────────

/**
 * Parallel composition: P | Q
 * Runs all processes concurrently and waits for all to complete.
 */
export function par<T extends any[]>(
  ...processes: { [K in keyof T]: Process<T[K]> }
): Process<T> {
  return async (ctx) => {
    const results = await Promise.all(
      processes.map((p, i) => {
        const childId = freshId("par");
        ctx.trace.emit({
          type: "spawn",
          runId: childId,
          parentId: ctx.runId,
          name: `par[${i}]`,
          ts: Date.now(),
        });

        const childCtx: ProcessContext = {
          ...ctx,
          runId: childId,
          parentId: ctx.runId,
        };

        return p(childCtx).then((r) => {
          ctx.trace.emit({ type: "done", runId: childId, ts: Date.now() });
          return r;
        });
      })
    );
    return results as T;
  };
}

/**
 * Sequential composition: P ; Q
 * Runs processes one after another, threading context.
 */
export function seq<T>(...processes: Process<any>[]): Process<T> {
  return async (ctx) => {
    let result: any;
    for (const p of processes) {
      if (ctx.signal.aborted) throw new Error("Process aborted");
      result = await p(ctx);
    }
    return result as T;
  };
}

/**
 * Choice: P + Q (external choice)
 *
 * Waits for a message on any of the guard channels.
 * The first channel that fires determines which branch runs.
 * All other branches are discarded (committed choice).
 */
export function choice<T>(
  branches: Array<{
    name: string;
    guard: Channel<any>;
    process: Process<T>;
  }>
): Process<T> {
  return async (ctx) => {
    const alternatives = branches.map((b) => b.name);
    let chosenIdx = -1;

    const cases: SelectCase<any>[] = branches.map((b, i) => ({
      channel: b.guard,
      handler: () => {
        chosenIdx = i;
      },
    }));

    await select(ctx.signal, ...cases);

    ctx.trace.emit({
      type: "branch",
      runId: ctx.runId,
      chosen: branches[chosenIdx].name,
      alternatives,
      ts: Date.now(),
    });

    return branches[chosenIdx].process(ctx);
  };
}

/**
 * Branch-Fix-Continue: the tree pattern you described.
 *
 * 1. Run the main process.
 * 2. If it signals a fix is needed (via the fix channel), pause main,
 *    run the fix process, then resume main from where it left off.
 * 3. If the main completes without needing a fix, continue normally.
 *
 * This is the key pattern for AI agents: you're coding along,
 * discover a lint error, branch to fix it, then rejoin the main flow.
 */
export function branchFix<T>(opts: {
  name: string;
  /** The main process. Receives a `requestFix` function it can call. */
  main: (requestFix: (reason: string) => Promise<void>) => Process<T>;
  /** Given the reason, produce a fix process. */
  fix: (reason: string) => Process<void>;
  /** Max number of fix cycles before giving up */
  maxFixes?: number;
}): Process<T> {
  const maxFixes = opts.maxFixes ?? 5;

  return async (ctx) => {
    let fixCount = 0;
    let lastFixError: Error | undefined;

    const fixChannel = new Channel<string>(`${opts.name}_fix`);
    const fixDone = new Channel<void>(`${opts.name}_fixdone`);

    const requestFix = async (reason: string): Promise<void> => {
      if (fixCount >= maxFixes) {
        throw new Error(
          `${opts.name}: exceeded max fix attempts (${maxFixes})`
        );
      }
      fixCount++;
      lastFixError = undefined;

      ctx.trace.emit({
        type: "fix_start",
        runId: ctx.runId,
        reason,
        ts: Date.now(),
      });

      await fixChannel.send(reason, ctx.signal);
      try {
        await fixDone.receive(ctx.signal);
      } catch (err) {
        throw lastFixError ?? err;
      }

      ctx.trace.emit({
        type: "fix_end",
        runId: ctx.runId,
        success: true,
        ts: Date.now(),
      });
    };

    const mainProcess = opts.main(requestFix);
    const mainPromise = mainProcess(ctx);

    const fixListenerPromise = (async () => {
      while (!fixChannel.closed) {
        let reason: string;
        try {
          reason = await fixChannel.receive(ctx.signal);
        } catch (err) {
          if (fixChannel.closed || ctx.signal.aborted) return;
          throw err;
        }

        try {
          await opts.fix(reason)(ctx);
          await fixDone.send(undefined, ctx.signal);
        } catch (err) {
          lastFixError = err instanceof Error ? err : new Error(String(err));
          ctx.trace.emit({
            type: "fix_end",
            runId: ctx.runId,
            success: false,
            ts: Date.now(),
          });
          fixDone.close();
          fixChannel.close();
          throw lastFixError;
        }
      }
    })();

    try {
      const result = await mainPromise;
      fixChannel.close();
      fixDone.close();
      await fixListenerPromise.catch(() => {});
      return result;
    } catch (err) {
      fixChannel.close();
      fixDone.close();
      await fixListenerPromise.catch(() => {});
      throw err;
    }
  };
}

/**
 * Restriction: ν(name). Creates a fresh scoped channel.
 * The channel is only visible to processes inside the scope.
 */
export function restrict<T, R>(
  name: string,
  body: (ch: Channel<T>) => Process<R>
): Process<R> {
  return async (ctx) => {
    const ch = new Channel<T>(name);
    const scopedChannels = new Map(ctx.channels);
    scopedChannels.set(name, ch);

    const scopedCtx: ProcessContext = { ...ctx, channels: scopedChannels };

    try {
      return await body(ch)(scopedCtx);
    } finally {
      ch.close();
    }
  };
}

/**
 * Replication: !P — spawn a new copy of P each time the trigger fires.
 * Useful for server-like patterns where each incoming request
 * gets its own agent process.
 */
export function replicate<T>(
  trigger: Channel<T>,
  handler: (value: T) => Process<void>
): Process<void> {
  return async (ctx) => {
    while (!ctx.signal.aborted && !trigger.closed) {
      let value: T;
      try {
        value = await trigger.receive(ctx.signal);
      } catch (err) {
        if (trigger.closed || ctx.signal.aborted) break;
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.message.includes("closed")) break;
        ctx.trace.emit({
          type: "error",
          runId: ctx.runId,
          error: error.message,
          ts: Date.now(),
        });
        throw error;
      }

      const childId = freshId("repl");
      ctx.trace.emit({
        type: "spawn",
        runId: childId,
        parentId: ctx.runId,
        name: "replicated",
        ts: Date.now(),
      });

      const childCtx: ProcessContext = {
        ...ctx,
        runId: childId,
        parentId: ctx.runId,
      };

      handler(value)(childCtx).catch((err) => {
        ctx.trace.emit({
          type: "error",
          runId: childId,
          error: String(err),
          ts: Date.now(),
        });
      });
    }
  };
}

/**
 * Supervisor: wraps a process with retry + fallback semantics.
 * On failure, can either restart the process or run a recovery process.
 */
export function supervisor<T>(opts: {
  name: string;
  process: Process<T>;
  maxRetries?: number;
  onError?: (err: Error, attempt: number) => Process<void>;
  fallback?: Process<T>;
}): Process<T> {
  const maxRetries = opts.maxRetries ?? 3;

  return async (ctx) => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await opts.process(ctx);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        ctx.trace.emit({
          type: "error",
          runId: ctx.runId,
          error: lastError.message,
          ts: Date.now(),
        });

        if (opts.onError && attempt < maxRetries) {
          await opts.onError(lastError, attempt)(ctx);
        }
      }
    }

    if (opts.fallback) {
      return opts.fallback(ctx);
    }

    throw lastError;
  };
}
