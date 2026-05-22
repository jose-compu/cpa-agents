import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Channel } from "../src/channel.js";
import {
  type Process,
  type ProcessContext,
  TraceCollector,
  par,
  seq,
  choice,
  branchFix,
  restrict,
  replicate,
  supervisor,
} from "../src/process.js";
import { Scheduler } from "../src/scheduler.js";

function makeScheduler() {
  return new Scheduler({ timeout: 5000 });
}

describe("par", () => {
  it("runs processes concurrently and collects results", async () => {
    const p1: Process<number> = async () => {
      await delay(20);
      return 1;
    };
    const p2: Process<number> = async () => {
      await delay(10);
      return 2;
    };
    const p3: Process<number> = async () => 3;

    const scheduler = makeScheduler();
    const result = await scheduler.run("par-test", par(p1, p2, p3));

    assert.ok(result.success);
    if (result.success) {
      assert.deepEqual(result.value, [1, 2, 3]);
    }
  });

  it("emits spawn events for each child", async () => {
    const p1: Process<void> = async () => {};
    const p2: Process<void> = async () => {};

    const scheduler = makeScheduler();
    await scheduler.run("par-trace", par(p1, p2));

    const spawns = scheduler.getTrace().filter((e) => e.type === "spawn");
    // root + 2 par children
    assert.ok(spawns.length >= 3);
  });
});

describe("seq", () => {
  it("runs processes in order", async () => {
    const order: number[] = [];

    const p1: Process<void> = async () => {
      await delay(10);
      order.push(1);
    };
    const p2: Process<void> = async () => {
      order.push(2);
    };
    const p3: Process<void> = async () => {
      order.push(3);
    };

    const scheduler = makeScheduler();
    await scheduler.run("seq-test", seq(p1, p2, p3));

    assert.deepEqual(order, [1, 2, 3]);
  });

  it("returns the last process result", async () => {
    const p1: Process<number> = async () => 1;
    const p2: Process<number> = async () => 2;
    const p3: Process<number> = async () => 42;

    const scheduler = makeScheduler();
    const result = await scheduler.run("seq-result", seq<number>(p1, p2, p3));

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, 42);
    }
  });
});

describe("choice", () => {
  it("runs the branch whose guard fires first", async () => {
    const chA = new Channel<string>("a");
    const chB = new Channel<string>("b");

    let chosen = "";

    const proc = choice([
      {
        name: "branch-a",
        guard: chA,
        process: async () => {
          chosen = "a";
        },
      },
      {
        name: "branch-b",
        guard: chB,
        process: async () => {
          chosen = "b";
        },
      },
    ]);

    const scheduler = makeScheduler();
    const runPromise = scheduler.run("choice-test", proc);

    // Fire branch B
    await chB.send("go");

    await runPromise;
    assert.equal(chosen, "b");

    chA.close();
    chB.close();
  });

  it("emits a branch trace event", async () => {
    const ch = new Channel<void>("guard");

    const proc = choice([
      {
        name: "only-branch",
        guard: ch,
        process: async () => {},
      },
    ]);

    const scheduler = makeScheduler();
    const runPromise = scheduler.run("choice-trace", proc);

    await ch.send(undefined);
    await runPromise;

    const branchEvents = scheduler
      .getTrace()
      .filter((e) => e.type === "branch");
    assert.equal(branchEvents.length, 1);
    if (branchEvents[0].type === "branch") {
      assert.equal(branchEvents[0].chosen, "only-branch");
    }

    ch.close();
  });
});

describe("branchFix", () => {
  it("runs main without fix when no errors", async () => {
    const proc = branchFix<string>({
      name: "no-fix",
      main: (_requestFix) => async () => "clean",
      fix: () => async () => {},
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-clean", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "clean");
    }
  });

  it("runs fix then continues when requestFix is called", async () => {
    let fixRan = false;
    let fixReason = "";

    const proc = branchFix<string>({
      name: "needs-fix",
      main: (requestFix) => async () => {
        await requestFix("lint error on line 42");
        return "fixed";
      },
      fix: (reason) => async () => {
        fixRan = true;
        fixReason = reason;
      },
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-fix", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "fixed");
    }
    assert.ok(fixRan);
    assert.equal(fixReason, "lint error on line 42");
  });

  it("supports multiple fix cycles", async () => {
    let fixCount = 0;

    const proc = branchFix<string>({
      name: "multi-fix",
      maxFixes: 5,
      main: (requestFix) => async () => {
        await requestFix("error 1");
        await requestFix("error 2");
        return "all fixed";
      },
      fix: () => async () => {
        fixCount++;
      },
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-multi", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "all fixed");
    }
    assert.equal(fixCount, 2);
  });

  it("fails after exceeding maxFixes", async () => {
    const proc = branchFix<string>({
      name: "too-many",
      maxFixes: 2,
      main: (requestFix) => async () => {
        await requestFix("err1");
        await requestFix("err2");
        await requestFix("err3"); // should throw
        return "never";
      },
      fix: () => async () => {},
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-exceed", proc);

    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.error.message.includes("exceeded max fix"));
    }
  });

  it("emits fix_start and fix_end trace events", async () => {
    const proc = branchFix<string>({
      name: "traced-fix",
      main: (requestFix) => async () => {
        await requestFix("some issue");
        return "ok";
      },
      fix: () => async () => {},
    });

    const scheduler = makeScheduler();
    await scheduler.run("branchfix-trace", proc);

    const trace = scheduler.getTrace();
    const fixStarts = trace.filter((e) => e.type === "fix_start");
    const fixEnds = trace.filter((e) => e.type === "fix_end");

    assert.equal(fixStarts.length, 1);
    assert.equal(fixEnds.length, 1);
    if (fixStarts[0].type === "fix_start") {
      assert.equal(fixStarts[0].reason, "some issue");
    }
  });

  it("propagates fix process errors and emits fix_end success false", async () => {
    const proc = branchFix<string>({
      name: "fix-throws",
      main: (requestFix) => async () => {
        await requestFix("broken");
        return "never";
      },
      fix: () => async () => {
        throw new Error("fix failed");
      },
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-fix-error", proc);

    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.error.message.includes("fix failed"));
    }

    const fixEnds = scheduler.getTrace().filter((e) => e.type === "fix_end");
    assert.equal(fixEnds.length, 1);
    if (fixEnds[0].type === "fix_end") {
      assert.equal(fixEnds[0].success, false);
    }
  });

  it("main rejection after requestFix does not hang", async () => {
    const proc = branchFix<string>({
      name: "main-rejects",
      main: (requestFix) => async () => {
        await requestFix("needs fix");
        throw new Error("main blew up");
      },
      fix: () => async () => {},
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("branchfix-main-reject", proc);

    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.error.message.includes("main blew up"));
    }
  });
});

describe("restrict", () => {
  it("creates a scoped channel available in the body", async () => {
    let channelSeen = false;

    const proc = restrict<number, void>("private", (ch) => async (ctx) => {
      assert.ok(ctx.channels.has("private"));
      channelSeen = true;
      // Channel works within scope
      const sendPromise = ch.send(42);
      const val = await ch.receive();
      await sendPromise;
      assert.equal(val, 42);
    });

    const scheduler = makeScheduler();
    await scheduler.run("restrict-test", proc);

    assert.ok(channelSeen);
  });

  it("closes the channel after scope exits", async () => {
    let capturedCh: Channel<number> | undefined;

    const proc = restrict<number, void>("will-close", (ch) => async () => {
      capturedCh = ch;
    });

    const scheduler = makeScheduler();
    await scheduler.run("restrict-close", proc);

    assert.ok(capturedCh);
    assert.ok(capturedCh.closed);
  });
});

describe("replicate", () => {
  it("spawns a handler for each trigger message", async () => {
    const trigger = new Channel<number>("trigger");
    let handled = 0;

    const proc = replicate(trigger, (n) => async () => {
      handled += n;
    });

    const scheduler = makeScheduler();
    const runPromise = scheduler.run("replicate-test", proc);

    await trigger.send(1);
    await trigger.send(2);
    await delay(20);
    trigger.close();
    await runPromise;

    assert.equal(handled, 3);
  });

  it("emits trace error on unexpected receive failure", async () => {
    class BrokenChannel extends Channel<number> {
      override receive(): Promise<number> {
        return Promise.reject(new Error("receive boom"));
      }
    }

    const trigger = new BrokenChannel("broken");
    const proc = replicate(trigger, () => async () => {});

    const scheduler = makeScheduler();
    const result = await scheduler.run("replicate-error", proc);

    assert.ok(!result.success);
    const errors = scheduler.getTrace().filter((e) => e.type === "error");
    assert.ok(errors.some((e) => e.type === "error" && e.error.includes("receive boom")));
  });
});

describe("supervisor", () => {
  it("returns result on first success", async () => {
    const proc = supervisor({
      name: "easy",
      process: async () => "ok",
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("super-ok", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "ok");
    }
  });

  it("retries on failure", async () => {
    let attempt = 0;

    const proc = supervisor({
      name: "retry",
      maxRetries: 3,
      process: async () => {
        attempt++;
        if (attempt < 3) throw new Error(`fail ${attempt}`);
        return "recovered";
      },
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("super-retry", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "recovered");
    }
    assert.equal(attempt, 3);
  });

  it("falls back after exhausting retries", async () => {
    const proc = supervisor({
      name: "fallback",
      maxRetries: 1,
      process: async () => {
        throw new Error("always fails");
      },
      fallback: async () => "fallback-value",
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("super-fallback", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "fallback-value");
    }
  });

  it("throws after exhausting retries with no fallback", async () => {
    const proc = supervisor({
      name: "no-fallback",
      maxRetries: 0,
      process: async () => {
        throw new Error("permanent");
      },
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("super-fail", proc);

    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.error.message.includes("permanent"));
    }
  });
});

describe("Scheduler", () => {
  it("produces a session tree", async () => {
    const proc = par(
      async () => 1,
      async () => 2
    );

    const scheduler = makeScheduler();
    const result = await scheduler.run("tree-test", proc);

    assert.ok(result.sessionTree.length > 0);
    const root = result.sessionTree[0];
    assert.equal(root.name, "tree-test");
    assert.ok(root.children.length >= 2);
  });

  it("handles timeout", async () => {
    const proc: Process<void> = async () => {
      await delay(10000);
    };

    const scheduler = new Scheduler({ timeout: 50 });
    const result = await scheduler.run("timeout-test", proc);

    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.error.message.includes("timeout"));
    }
  });
});

// ─── Helpers ────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
