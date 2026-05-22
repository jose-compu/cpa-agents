/**
 * Scheduler: the runtime that executes process trees.
 *
 * Handles:
 * - Process lifecycle (spawn, run, complete, error)
 * - Cooperative scheduling via async/await
 * - Deadlock detection (all processes blocked on channels, none can fire)
 * - Graceful shutdown via AbortController
 */

import { freshId } from "./channel.js";
import {
  type Process,
  type ProcessContext,
  type TraceCollector,
  type TraceEvent,
  TraceCollector as TraceCollectorImpl,
} from "./process.js";
import { JsonlTraceSink } from "./jsonl.js";

export interface SchedulerOpts {
  /** Timeout for the entire process tree (ms) */
  timeout?: number;
  /** Callback when a trace event is emitted */
  onTrace?: (event: TraceEvent) => void;
}

export class Scheduler {
  private abortController: AbortController;
  private trace: TraceCollectorImpl;
  private opts: SchedulerOpts;
  private jsonlSink?: JsonlTraceSink;
  private onTraceListeners: Array<(event: TraceEvent) => void>;

  constructor(opts: SchedulerOpts = {}) {
    this.abortController = new AbortController();
    this.opts = opts;
    this.onTraceListeners = opts.onTrace ? [opts.onTrace] : [];
    const listeners = this.onTraceListeners;
    this.trace = new (class extends TraceCollectorImpl {
      emit(event: TraceEvent): void {
        super.emit(event);
        for (const listener of listeners) {
          listener(event);
        }
      }
    })();
  }

  /**
   * Append trace events to a JSONL file as they fire.
   * Returns a handle to flush and close the sink.
   */
  attachJsonl(path: string): { close: () => Promise<void> } {
    this.jsonlSink = new JsonlTraceSink(path);
    const listener = (event: TraceEvent) => {
      this.jsonlSink?.append(event);
    };
    this.onTraceListeners.push(listener);
    return {
      close: async () => {
        await this.jsonlSink?.close();
        this.jsonlSink = undefined;
        const idx = this.onTraceListeners.indexOf(listener);
        if (idx >= 0) this.onTraceListeners.splice(idx, 1);
      },
    };
  }

  /** Read-only access to the live trace collector. */
  get traceCollector(): TraceCollector {
    return this.trace;
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
