import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compose,
  converse,
  detRel,
  domRestrict,
  empty,
  fork,
  forkN,
  forkToProcess,
  identity,
  join,
  meet,
  proj1,
  proj2,
  ranRestrict,
  rel,
  toProcess,
  verifyAxioms,
} from "../src/fork-algebra.js";
import { Scheduler } from "../src/scheduler.js";

function sched() {
  return new Scheduler({ timeout: 5000 });
}

describe("fork algebra primitives", () => {
  it("rel and detRel execute relation functions", async () => {
    const r = rel<number, number>("double", async (n) => [n * 2, n * 3]);
    const d = detRel<number, number>("inc", async (n) => n + 1);
    assert.deepEqual(await r.fn(2), [4, 6]);
    assert.deepEqual(await d.fn(2), [3]);
  });

  it("compose, join, meet, identity, empty", async () => {
    const plus1 = rel<number, number>("plus1", async (n) => [n + 1]);
    const times2 = rel<number, number>("times2", async (n) => [n * 2]);
    const comp = compose(plus1, times2);
    assert.deepEqual(await comp.fn(3), [8]);

    const union = join(
      rel("a", async (n: number) => [n, n + 1]),
      rel("b", async (n: number) => [n + 1, n + 2]),
      (x, y) => x === y
    );
    assert.deepEqual(await union.fn(1), [1, 2, 3]);

    const inter = meet(
      rel("l", async (n: number) => [n, n + 1]),
      rel("r", async (n: number) => [n + 1, n + 2])
    );
    assert.deepEqual(await inter.fn(1), [2]);

    assert.deepEqual(await identity<number>().fn(9), [9]);
    assert.deepEqual(await empty<number, number>().fn(9), []);
  });
});

describe("fork and projections", () => {
  it("fork builds cartesian paired outputs", async () => {
    const left = rel("left", async (n: number) => [n, n + 1]);
    const right = rel("right", async (n: number) => [n * 10]);
    const f = fork(left, right);
    assert.deepEqual(await f.fn(2), [
      [2, 20],
      [3, 20],
    ]);
  });

  it("forkN builds N-ary cartesian product", async () => {
    const a = rel("a", async (_: number) => [1, 2]);
    const b = rel("b", async (_: number) => [10]);
    const c = rel("c", async (_: number) => [100, 200]);
    const f = forkN(a, b, c);
    assert.deepEqual(await f.fn(0), [
      [1, 10, 100],
      [1, 10, 200],
      [2, 10, 100],
      [2, 10, 200],
    ]);
  });

  it("projections extract tuple components", async () => {
    assert.deepEqual(await proj1<number, string>().fn([7, "x"]), [7]);
    assert.deepEqual(await proj2<number, string>().fn([7, "x"]), ["x"]);
  });
});

describe("restrictions + conversion to process", () => {
  it("domain/range restrictions filter relation flow", async () => {
    const guardPositive = rel("guard+", async (n: number) => (n > 0 ? [n] : []));
    const body = rel("square", async (n: number) => [n * n]);
    const dom = domRestrict(guardPositive, body);

    assert.deepEqual(await dom.fn(2), [4]);
    assert.deepEqual(await dom.fn(-1), []);

    const produced = rel("vals", async (_: number) => [1, 2, 3, 4]);
    const keepEven = rel("even", async (n: number) => (n % 2 === 0 ? [n] : []));
    const ran = ranRestrict(produced, keepEven);
    assert.deepEqual(await ran.fn(0), [2, 4]);
  });

  it("toProcess/forkToProcess execute relations inside scheduler", async () => {
    const s = sched();
    const r = rel("vals", async (n: number) => [n, n + 1]);
    const first = await s.run("rel-first", toProcess(r, 2, "first"));
    assert.ok(first.success && first.value === 2);

    const all = await s.run("rel-all", toProcess(r, 2, "all"));
    assert.ok(all.success);
    if (all.success) assert.deepEqual(all.value, [2, 3]);

    const emptyRel = rel<number, number>("none", async () => []);
    const fail = await s.run("rel-fail", toProcess(emptyRel, 1, "first"));
    assert.ok(!fail.success);

    const fp = await s.run(
      "fork-process",
      forkToProcess(
        rel("l", async (n: number) => [n]),
        rel("r", async (n: number) => [n * 10]),
        3
      )
    );
    assert.ok(fp.success);
    if (fp.success) assert.deepEqual(fp.value, [[3], [30]]);
  });
});

describe("converse and axioms", () => {
  it("converse uses provided inverse mapping", async () => {
    const forward = rel("double", async (n: number) => [n * 2]);
    const inv = converse(forward, async (n: number) => [n / 2]);
    assert.deepEqual(await inv.fn(8), [4]);
  });

  it("verifyAxioms passes for simple compatible relations", async () => {
    const r = rel("r", async (n: number) => [n + 1]);
    const s = rel("s", async (n: number) => [n * 2]);
    const check = await verifyAxioms(r, s, [1, 2, 3]);
    assert.equal(check.passed, true);
    assert.deepEqual(check.failures, []);
  });
});
