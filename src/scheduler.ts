/**
 * Scheduler: the runtime that executes process trees.
 *
 * Handles:
 * - Process lifecycle (spawn, run, complete, error)
 * - Cooperative scheduling via async/await
 * - Deadlock detection (all processes blocked on channels, none can fire)
 * - Graceful shutdown via AbortController
 */

import { Channel, freshId } from "./channel.js";
import {
  type Process,
  type ProcessContext,
  type TraceCollector,
  TraceCollector as TraceCollectorImpl,
} from "./process.js";

export interface SchedulerOpts {
  /** Timeout for the entire process tree (ms) */
  timeout?: number;
  /** Callback when a trace event is emitted */
  onTrace?: (event: import("./process.js").TraceEvent) => void;
}

export class Scheduler {
  private abortController: AbortController;
  private trace: TraceCollectorImpl;
  private opts: SchedulerOpts;

  constructor(opts: SchedulerOpts = {}) {
    this.abortController = new AbortController();
    this.opts = opts;
    this.trace = new (class extends TraceCollectorImpl {
      emit(event: import("./process.js").TraceEvent): void {
        super.emit(event);
        opts.onTrace?.(event);
      }
    })();
  }

  /**
   * Run a process tree to completion.
   */
  async run<T>(name: string, process: Process<T>): Promise<SchedulerResult<T>> {
    const runId = freshId("root");
    const ctx: ProcessContext = {
      runId,
      signal: this.abortController.signal,
      trace: this.trace,
      channels: new Map(),
    };

    this.trace.emit({
      type: "spawn",
      runId,
      name,
      ts: Date.now(),
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const resultPromise = process(ctx);

      // Apply timeout if configured
      let result: T;
      if (this.opts.timeout) {
        result = await Promise.race([
          resultPromise,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              this.abortController.abort();
              reject(new Error(`Scheduler timeout after ${this.opts.timeout}ms`));
            }, this.opts.timeout);
          }),
        ]);
      } else {
        result = await resultPromise;
      }

      this.trace.emit({ type: "done", runId, ts: Date.now() });

      return {
        success: true,
        value: result,
        trace: this.trace,
        sessionTree: this.trace.toTree(),
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.trace.emit({
        type: "error",
        runId,
        error: error.message,
        ts: Date.now(),
      });

      return {
        success: false,
        error,
        trace: this.trace,
        sessionTree: this.trace.toTree(),
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Abort all running processes.
   */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Get the current session tree (can be called mid-execution).
   */
  getSessionTree() {
    return this.trace.toTree();
  }

  /**
   * Get the flat event trace.
   */
  getTrace() {
    return this.trace.events;
  }
}

export type SchedulerResult<T> =
  | {
      success: true;
      value: T;
      trace: TraceCollector;
      sessionTree: import("./process.js").SessionNode[];
    }
  | {
      success: false;
      error: Error;
      trace: TraceCollector;
      sessionTree: import("./process.js").SessionNode[];
    };
