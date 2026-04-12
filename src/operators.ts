import { freshId } from "./channel.js";
import { type Process, type ProcessContext } from "./process.js";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: Error): Result<T> {
  return { ok: false, error };
}

export function attempt<T>(process: Process<T>): Process<Result<T>> {
  return async (ctx) => {
    try {
      const value = await process(ctx);
      return ok(value);
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function and<A, B>(a: Process<A>, b: Process<B>): Process<Result<B>> {
  return async (ctx) => {
    const aResult = await attempt(a)(ctx);
    if (!aResult.ok) return fail(aResult.error);
    return attempt(b)(ctx);
  };
}

export function or<T>(a: Process<T>, b: Process<T>): Process<Result<T>> {
  return async (ctx) => {
    const aResult = await attempt(a)(ctx);
    if (aResult.ok) return aResult;

    ctx.trace.emit({
      type: "branch",
      runId: ctx.runId,
      chosen: "fallback",
      alternatives: ["primary", "fallback"],
      ts: Date.now(),
    });

    return attempt(b)(ctx);
  };
}

export function ifThenElse<T>(
  condition: Process<unknown>,
  then: Process<T>,
  otherwise: Process<T>
): Process<T> {
  return async (ctx) => {
    const condResult = await attempt(condition)(ctx);

    ctx.trace.emit({
      type: "branch",
      runId: ctx.runId,
      chosen: condResult.ok ? "then" : "else",
      alternatives: ["then", "else"],
      ts: Date.now(),
    });

    if (condResult.ok) return then(ctx);
    return otherwise(ctx);
  };
}

export function pipe<A, B>(a: Process<A>, b: (input: A) => Process<B>): Process<B> {
  return async (ctx) => {
    const aResult = await a(ctx);
    return b(aResult)(ctx);
  };
}

export function pipeChain<T>(
  first: Process<T>,
  ...rest: Array<(input: any) => Process<any>>
): Process<any> {
  return async (ctx) => {
    let result: any = await first(ctx);
    for (const step of rest) {
      result = await step(result)(ctx);
    }
    return result;
  };
}

export interface BackgroundHandle<T> {
  wait: () => Promise<Result<T>>;
  abort: () => void;
}

export function bg<T>(process: Process<T>): Process<BackgroundHandle<T>> {
  return async (ctx) => {
    const bgController = new AbortController();
    const mergedSignal = anySignal(ctx.signal, bgController.signal);

    const bgCtx: ProcessContext = {
      ...ctx,
      runId: freshId("bg"),
      parentId: ctx.runId,
      signal: mergedSignal,
    };

    ctx.trace.emit({
      type: "spawn",
      runId: bgCtx.runId,
      parentId: ctx.runId,
      name: "background",
      ts: Date.now(),
    });

    const promise = attempt(process)(bgCtx).then((result) => {
      ctx.trace.emit({
        type: result.ok ? "done" : "error",
        runId: bgCtx.runId,
        ...(result.ok ? {} : { error: result.error.message }),
        ts: Date.now(),
      } as any);
      return result;
    });

    return {
      wait: () => promise,
      abort: () => bgController.abort(),
    };
  };
}

export function not(process: Process<unknown>): Process<void> {
  return async (ctx) => {
    const result = await attempt(process)(ctx);
    if (result.ok) {
      throw new Error("Process succeeded (not operator inverts this to failure)");
    }
  };
}

export async function waitAll<T>(
  handles: BackgroundHandle<T>[]
): Promise<Result<T>[]> {
  return Promise.all(handles.map((h) => h.wait()));
}

export function andChain(...processes: Process<any>[]): Process<Result<any>> {
  return async (ctx) => {
    let lastResult: Result<any> = ok(undefined);
    for (const p of processes) {
      lastResult = await attempt(p)(ctx);
      if (!lastResult.ok) return lastResult;
    }
    return lastResult;
  };
}

export function orChain<T>(...processes: Process<T>[]): Process<Result<T>> {
  return async (ctx) => {
    let lastResult: Result<T> = fail(new Error("No processes in orChain"));
    for (const p of processes) {
      lastResult = await attempt(p)(ctx);
      if (lastResult.ok) return lastResult;
    }
    return lastResult;
  };
}

export function subshell<T>(name: string, process: Process<T>): Process<T> {
  return async (ctx) => {
    const subId = freshId("sub");
    const subCtx: ProcessContext = {
      ...ctx,
      runId: subId,
      parentId: ctx.runId,
      channels: new Map(ctx.channels),
    };

    ctx.trace.emit({
      type: "spawn",
      runId: subId,
      parentId: ctx.runId,
      name: `(${name})`,
      ts: Date.now(),
    });

    const result = await process(subCtx);

    ctx.trace.emit({
      type: "done",
      runId: subId,
      ts: Date.now(),
    });

    return result;
  };
}

export interface Invertible<T> {
  forward: Process<T>;
  undo: (result: T) => Process<void>;
}

export function invertible<T>(
  forward: Process<T>,
  undo: (result: T) => Process<void>
): Invertible<T> {
  return { forward, undo };
}

export function runInvertible<T>(inv: Invertible<T>): Process<T> {
  return inv.forward;
}

export function saga(steps: Invertible<any>[]): Process<any[]> {
  return async (ctx) => {
    const completed: Array<{ result: any; undo: (result: any) => Process<void> }> = [];

    for (const step of steps) {
      const result = await attempt(step.forward)(ctx);

      if (!result.ok) {
        ctx.trace.emit({
          type: "fix_start",
          runId: ctx.runId,
          reason: `Saga rollback: ${result.error.message}`,
          ts: Date.now(),
        });

        for (let i = completed.length - 1; i >= 0; i--) {
          const comp = completed[i];
          try {
            await comp.undo(comp.result)(ctx);
          } catch (undoErr) {
            ctx.trace.emit({
              type: "error",
              runId: ctx.runId,
              error: `Compensation failed at step ${i}: ${undoErr}`,
              ts: Date.now(),
            });
          }
        }

        ctx.trace.emit({
          type: "fix_end",
          runId: ctx.runId,
          success: false,
          ts: Date.now(),
        });

        throw result.error;
      }

      completed.push({ result: result.value, undo: step.undo });
    }

    return completed.map((c) => c.result);
  };
}

export function guard(
  name: string,
  predicate: (ctx: ProcessContext) => Promise<boolean>
): Process<void> {
  return async (ctx) => {
    const passed = await predicate(ctx);
    if (!passed) throw new Error(`Guard failed: ${name}`);
  };
}

export function guardValue<T>(
  name: string,
  extract: (ctx: ProcessContext) => Promise<T | null | undefined>
): Process<T> {
  return async (ctx) => {
    const value = await extract(ctx);
    if (value === null || value === undefined) {
      throw new Error(`Guard failed (no value): ${name}`);
    }
    return value;
  };
}

export function timeout<T>(ms: number, process: Process<T>): Process<T> {
  return async (ctx) =>
    Promise.race([
      process(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
      ),
    ]);
}

export function retryWithBackoff<T>(opts: {
  process: Process<T>;
  maxAttempts: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryIf?: (err: Error) => boolean;
}): Process<T> {
  const {
    process,
    maxAttempts,
    initialDelayMs = 100,
    maxDelayMs = 30000,
    backoffFactor = 2,
    retryIf,
  } = opts;

  return async (ctx) => {
    let delay = initialDelayMs;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ctx.signal.aborted) throw new Error("Aborted");

      const result = await attemptFn(process)(ctx);
      if (result.ok) return result.value;
      lastError = result.error;

      if (retryIf && !retryIf(lastError)) throw lastError;

      if (attempt < maxAttempts - 1) {
        ctx.trace.emit({
          type: "fix_start",
          runId: ctx.runId,
          reason: `Retry ${attempt + 1}/${maxAttempts}: ${lastError.message}`,
          ts: Date.now(),
        });

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * backoffFactor, maxDelayMs);

        ctx.trace.emit({
          type: "fix_end",
          runId: ctx.runId,
          success: false,
          ts: Date.now(),
        });
      }
    }

    throw lastError!;
  };
}

function attemptFn<T>(process: Process<T>): Process<Result<T>> {
  return async (ctx) => {
    try {
      return ok(await process(ctx));
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}
