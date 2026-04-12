import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  and,
  andChain,
  attempt,
  bg,
  guard,
  guardValue,
  ifThenElse,
  invertible,
  not,
  or,
  orChain,
  pipe,
  pipeChain,
  retryWithBackoff,
  saga,
  subshell,
  timeout,
  unwrap,
} from "../src/operators.js";
import type { Process } from "../src/process.js";
import { Scheduler } from "../src/scheduler.js";

function sched() {
  return new Scheduler({ timeout: 5000 });
}

const succeed = <T>(value: T): Process<T> => async () => value;
const failWith = (msg: string): Process<never> => async () => {
  throw new Error(msg);
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("operators basic", () => {
  it("attempt wraps success/failure and unwrap works", async () => {
    const okRun = await sched().run("attempt-ok", attempt(succeed(42)));
    assert.ok(okRun.success);
    if (okRun.success) assert.deepEqual(okRun.value, { ok: true, value: 42 });

    const failRun = await sched().run("attempt-fail", attempt(failWith("boom")));
    assert.ok(failRun.success);
    if (failRun.success) {
      assert.equal(failRun.value.ok, false);
      if (!failRun.value.ok) assert.equal(failRun.value.error.message, "boom");
    }

    assert.equal(unwrap({ ok: true, value: 1 }), 1);
    assert.throws(() => unwrap({ ok: false, error: new Error("x") }), /x/);
  });

  it("and/or model bash-style short circuit behavior", async () => {
    const andOk = await sched().run("and-ok", and(succeed(1), succeed(2)));
    assert.ok(andOk.success && andOk.value.ok && andOk.value.value === 2);

    let bRan = false;
    const andFail = await sched().run(
      "and-fail",
      and(failWith("nope"), async () => {
        bRan = true;
        return 9;
      })
    );
    assert.ok(andFail.success && !andFail.value.ok);
    assert.equal(bRan, false);

    const orOk = await sched().run("or-ok", or(succeed(3), succeed(8)));
    assert.ok(orOk.success && orOk.value.ok && orOk.value.value === 3);

    const orFail = await sched().run("or-fail", or(failWith("x"), succeed(8)));
    assert.ok(orFail.success && orFail.value.ok && orFail.value.value === 8);
  });

  it("ifThenElse and pipe operators route/process data", async () => {
    const thenRun = await sched().run(
      "if-then",
      ifThenElse(succeed(true), succeed("yes"), succeed("no"))
    );
    assert.ok(thenRun.success && thenRun.value === "yes");

    const elseRun = await sched().run(
      "if-else",
      ifThenElse(failWith("cond"), succeed("yes"), succeed("no"))
    );
    assert.ok(elseRun.success && elseRun.value === "no");

    const piped = await sched().run(
      "pipe",
      pipe(succeed(5), (n) => succeed(n * 10))
    );
    assert.ok(piped.success && piped.value === 50);

    const chain = await sched().run(
      "pipe-chain",
      pipeChain(
        succeed(2),
        (n: number) => succeed(n + 3),
        (n: number) => succeed(n * 10),
        (n: number) => succeed(`result:${n}`)
      )
    );
    assert.ok(chain.success && chain.value === "result:50");
  });
});

describe("operators advanced", () => {
  it("bg returns a handle and can be awaited", async () => {
    const run = await sched().run(
      "bg",
      bg(async () => {
        await delay(20);
        return 42;
      })
    );
    assert.ok(run.success);
    if (run.success) {
      const res = await run.value.wait();
      assert.ok(res.ok);
      if (res.ok) assert.equal(res.value, 42);
      run.value.abort();
    }
  });

  it("not inverts process success", async () => {
    const shouldPass = await sched().run("not-pass", not(failWith("err")));
    assert.ok(shouldPass.success);

    const shouldFail = await sched().run("not-fail", not(succeed(1)));
    assert.ok(!shouldFail.success);
  });

  it("andChain/orChain short-circuit as expected", async () => {
    const order: number[] = [];
    const andRun = await sched().run(
      "and-chain",
      andChain(
        async () => order.push(1),
        async () => order.push(2),
        async () => order.push(3)
      )
    );
    assert.ok(andRun.success && andRun.value.ok);
    assert.deepEqual(order, [1, 2, 3]);

    const orOrder: string[] = [];
    const orRun = await sched().run(
      "or-chain",
      orChain(
        async () => {
          orOrder.push("a");
          throw new Error("a fails");
        },
        async () => {
          orOrder.push("b");
          return "b wins";
        },
        async () => {
          orOrder.push("c");
          return "c";
        }
      )
    );
    assert.ok(orRun.success && orRun.value.ok);
    if (orRun.success && orRun.value.ok) assert.equal(orRun.value.value, "b wins");
    assert.deepEqual(orOrder, ["a", "b"]);
  });

  it("subshell, guard, guardValue, timeout", async () => {
    const sub = await sched().run("subshell", subshell("inner", succeed(42)));
    assert.ok(sub.success && sub.value === 42);

    const guardOk = await sched().run("guard-ok", guard("always", async () => true));
    assert.ok(guardOk.success);

    const guardFail = await sched().run("guard-fail", guard("never", async () => false));
    assert.ok(!guardFail.success);

    const gv = await sched().run("guard-value", guardValue("extract", async () => "Alice"));
    assert.ok(gv.success && gv.value === "Alice");

    const timeoutOk = await sched().run("timeout-ok", timeout(1000, succeed(1)));
    assert.ok(timeoutOk.success && timeoutOk.value === 1);

    const timeoutFail = await sched().run(
      "timeout-fail",
      timeout(20, async () => {
        await delay(200);
        return 1;
      })
    );
    assert.ok(!timeoutFail.success);
  });
});

describe("invertible + saga + retry", () => {
  it("saga executes and rolls back in reverse order on failure", async () => {
    const log: string[] = [];
    const steps = [
      invertible(
        async () => {
          log.push("step1");
          return "a";
        },
        () => async () => {
          log.push("undo1");
        }
      ),
      invertible(
        async () => {
          log.push("step2");
          return "b";
        },
        () => async () => {
          log.push("undo2");
        }
      ),
      invertible<string>(
        async () => {
          log.push("step3");
          throw new Error("fail");
        },
        () => async () => {
          log.push("undo3");
        }
      ),
    ];

    const run = await sched().run("saga", saga(steps));
    assert.ok(!run.success);
    assert.deepEqual(log, ["step1", "step2", "step3", "undo2", "undo1"]);
  });

  it("retryWithBackoff retries and can stop on retryIf", async () => {
    let attempts = 0;
    const eventually = await sched().run(
      "retry-ok",
      retryWithBackoff({
        process: async () => {
          attempts++;
          if (attempts < 3) throw new Error("transient");
          return "done";
        },
        maxAttempts: 5,
        initialDelayMs: 1,
      })
    );
    assert.ok(eventually.success && eventually.value === "done");
    assert.equal(attempts, 3);

    let noRetryAttempts = 0;
    const noRetry = await sched().run(
      "retry-stop",
      retryWithBackoff({
        process: async () => {
          noRetryAttempts++;
          throw new Error("fatal");
        },
        maxAttempts: 5,
        initialDelayMs: 1,
        retryIf: (err) => err.message !== "fatal",
      })
    );
    assert.ok(!noRetry.success);
    assert.equal(noRetryAttempts, 1);
  });
});
