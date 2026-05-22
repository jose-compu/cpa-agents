/**
 * cpa-agents — Concurrent Process Algebra for AI Agents
 *
 * Channel<T>: typed communication channel with π-calculus semantics.
 * Supports synchronous rendezvous (sender blocks until receiver is ready).
 */

export type ChannelId = string & { __brand: "ChannelId" };

let _nextId = 0;
export function freshId(prefix = "ch"): ChannelId {
  return `${prefix}_${_nextId++}` as ChannelId;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

/**
 * A typed, named channel. Corresponds to π-calculus names.
 * Channels can be sent over other channels (mobility).
 */
export class Channel<T = unknown> {
  readonly id: ChannelId;
  readonly name: string;
  private sendQueue: Array<{ value: T; done: Waiter<void> }> = [];
  private recvQueue: Array<Waiter<T>> = [];
  private _closed = false;

  constructor(name?: string) {
    this.id = freshId(name ?? "ch");
    this.name = name ?? this.id;
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Send a value. Blocks until a receiver picks it up (rendezvous).
   * In π-calculus: ā⟨v⟩.P — output v on channel a, then continue as P.
   */
  send(value: T, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (this._closed) {
      return Promise.reject(new Error(`Channel ${this.name} is closed`));
    }

    const receiver = this.recvQueue.shift();
    if (receiver) {
      receiver.cleanup?.();
      receiver.resolve(value);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: { value: T; done: Waiter<void> } = {
        value,
        done: { resolve, reject },
      };

      const onAbort = () => {
        const idx = this.sendQueue.indexOf(entry);
        if (idx >= 0) this.sendQueue.splice(idx, 1);
        reject(abortError(signal));
      };

      if (signal) {
        entry.done.cleanup = () =>
          signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendQueue.push(entry);
    });
  }

  /**
   * Receive a value. Blocks until a sender provides one.
   * In π-calculus: a(x).P — input x from channel a, then continue as P.
   */
  receive(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (this._closed && this.sendQueue.length === 0) {
      return Promise.reject(new Error(`Channel ${this.name} is closed`));
    }

    const sender = this.sendQueue.shift();
    if (sender) {
      sender.done.cleanup?.();
      sender.done.resolve();
      return Promise.resolve(sender.value);
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };

      const onAbort = () => {
        const idx = this.recvQueue.indexOf(waiter);
        if (idx >= 0) this.recvQueue.splice(idx, 1);
        reject(abortError(signal));
      };

      if (signal) {
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.recvQueue.push(waiter);
    });
  }

  /**
   * Non-blocking try-receive. Returns undefined if nothing is waiting.
   */
  tryReceive(): T | undefined {
    const sender = this.sendQueue.shift();
    if (sender) {
      sender.done.cleanup?.();
      sender.done.resolve();
      return sender.value;
    }
    return undefined;
  }

  /**
   * Close the channel. Rejects all pending waiters.
   */
  close(): void {
    this._closed = true;
    this.cancelPendingWaiters(new Error(`Channel ${this.name} closed`));
  }

  /** Cancel pending receivers without closing the channel. */
  cancelPendingReceives(reason?: Error): void {
    const err = reason ?? abortError();
    for (const w of this.recvQueue) {
      w.cleanup?.();
      w.reject(err);
    }
    this.recvQueue = [];
  }

  /** Cancel pending senders without closing the channel. */
  cancelPendingSends(reason?: Error): void {
    const err = reason ?? abortError();
    for (const w of this.sendQueue) {
      w.done.cleanup?.();
      w.done.reject(err);
    }
    this.sendQueue = [];
  }

  private cancelPendingWaiters(err: Error): void {
    for (const w of this.sendQueue) {
      w.done.cleanup?.();
      w.done.reject(err);
    }
    for (const w of this.recvQueue) {
      w.cleanup?.();
      w.reject(err);
    }
    this.sendQueue = [];
    this.recvQueue = [];
  }

  /**
   * π-calculus restriction: ν(x). Creates a fresh channel
   * scoped to the provided function. The channel is closed
   * when the scope exits.
   */
  static async restrict<T, R>(
    name: string,
    body: (ch: Channel<T>) => Promise<R>
  ): Promise<R> {
    const ch = new Channel<T>(name);
    try {
      return await body(ch);
    } finally {
      ch.close();
    }
  }
}

/**
 * Select: π-calculus external choice (P + Q).
 * Waits on multiple channels, returns the first that fires.
 * Losing branches are cancelled so receivers do not leak.
 */
export interface SelectCase<T> {
  channel: Channel<T>;
  handler: (value: T) => Promise<void> | void;
}

export async function select(
  signal: AbortSignal,
  ...cases: SelectCase<any>[]
): Promise<void>;
export async function select(...cases: SelectCase<any>[]): Promise<void>;
export async function select(
  signalOrCase: AbortSignal | SelectCase<any>,
  ...rest: SelectCase<any>[]
): Promise<void> {
  let signal: AbortSignal | undefined;
  let cases: SelectCase<any>[];

  if (isAbortSignal(signalOrCase)) {
    signal = signalOrCase;
    cases = rest;
  } else {
    cases = [signalOrCase, ...rest];
  }

  if (cases.length === 0) {
    throw new Error("select requires at least one case");
  }

  const raceAbort = new AbortController();
  const parentAbort = signal;
  const caseControllers = cases.map(() => new AbortController());

  const merged = (caseAbort: AbortController) =>
    mergeAbortSignals(parentAbort, raceAbort.signal, caseAbort.signal);

  const result = await new Promise<{ index: number; value: unknown }>(
    (resolve, reject) => {
      let settled = false;
      let failures = 0;

      cases.forEach((c, i) => {
        const caseAbort = caseControllers[i];
        c.channel
          .receive(merged(caseAbort))
          .then((value) => {
            if (settled) return;
            settled = true;
            for (let j = 0; j < cases.length; j++) {
              if (j !== i) {
                caseControllers[j].abort();
                cases[j].channel.cancelPendingReceives(abortError());
              }
            }
            raceAbort.abort();
            resolve({ index: i, value });
          })
          .catch((err) => {
            if (settled) return;
            failures++;
            if (failures === cases.length) {
              reject(err);
            }
          });
      });
    }
  );

  await cases[result.index].handler(result.value);
}

function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true }
    );
  }
  return controller.signal;
}
