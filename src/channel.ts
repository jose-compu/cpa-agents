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
  send(value: T): Promise<void> {
    if (this._closed) {
      return Promise.reject(new Error(`Channel ${this.name} is closed`));
    }

    // If a receiver is already waiting, hand off directly
    const receiver = this.recvQueue.shift();
    if (receiver) {
      receiver.resolve(value);
      return Promise.resolve();
    }

    // Otherwise, block until a receiver appears
    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push({ value, done: { resolve, reject } });
    });
  }

  /**
   * Receive a value. Blocks until a sender provides one.
   * In π-calculus: a(x).P — input x from channel a, then continue as P.
   */
  receive(): Promise<T> {
    if (this._closed && this.sendQueue.length === 0) {
      return Promise.reject(new Error(`Channel ${this.name} is closed`));
    }

    // If a sender is already waiting, hand off directly
    const sender = this.sendQueue.shift();
    if (sender) {
      sender.done.resolve();
      return Promise.resolve(sender.value);
    }

    // Otherwise, block until a sender appears
    return new Promise<T>((resolve, reject) => {
      this.recvQueue.push({ resolve, reject });
    });
  }

  /**
   * Non-blocking try-receive. Returns undefined if nothing is waiting.
   */
  tryReceive(): T | undefined {
    const sender = this.sendQueue.shift();
    if (sender) {
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
    const err = new Error(`Channel ${this.name} closed`);
    for (const w of this.sendQueue) w.done.reject(err);
    for (const w of this.recvQueue) w.reject(err);
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
 */
export interface SelectCase<T> {
  channel: Channel<T>;
  handler: (value: T) => Promise<void> | void;
}

export async function select(...cases: SelectCase<any>[]): Promise<void> {
  // Race all receives
  const result = await Promise.race(
    cases.map(async (c, i) => {
      const value = await c.channel.receive();
      return { index: i, value };
    })
  );

  await cases[result.index].handler(result.value);
}
