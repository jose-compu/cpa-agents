import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentCall,
  type CheckResult,
  agentProcess,
  codeThenFix,
  fanOut,
  handoff,
} from "../src/agent.js";
import { Scheduler } from "../src/scheduler.js";

function makeScheduler() {
  return new Scheduler({ timeout: 5000 });
}

// ─── Mock agents ────────────────────────────────────────────────

function mockAgent<TIn, TOut>(
  name: string,
  fn: (input: TIn) => TOut
): AgentCall<TIn, TOut> {
  return {
    name,
    invoke: async (input: TIn, _signal: AbortSignal) => fn(input),
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("agentProcess", () => {
  it("wraps an agent call as a process", async () => {
    const agent = mockAgent<string, number>("counter", (s) => s.length);
    const proc = agentProcess(agent, "hello");

    const scheduler = makeScheduler();
    const result = await scheduler.run("agent-test", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, 5);
    }
  });

  it("emits spawn and done trace events", async () => {
    const agent = mockAgent<void, string>("simple", () => "done");
    const proc = agentProcess(agent, undefined);

    const scheduler = makeScheduler();
    await scheduler.run("agent-trace", proc);

    const trace = scheduler.getTrace();
    assert.ok(trace.some((e) => e.type === "spawn"));
    assert.ok(trace.some((e) => e.type === "done"));
  });
});

describe("codeThenFix", () => {
  it("passes without fix when checker returns pass", async () => {
    const coder = mockAgent<string, string>("coder", (t) => `code for ${t}`);
    const checker = mockAgent<string, CheckResult>("checker", () => ({
      pass: true,
      errors: [],
    }));
    const fixer = mockAgent<{ code: string; errors: string[] }, string>(
      "fixer",
      ({ code }) => code
    );

    const proc = codeThenFix({
      coder,
      checker,
      fixer,
      task: "build auth",
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("ctf-clean", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "code for build auth");
    }
  });

  it("runs fixer when checker fails, then re-checks", async () => {
    let checkCount = 0;
    let fixCount = 0;

    const coder = mockAgent<string, string>("coder", () => "bad code");
    const checker = mockAgent<string, CheckResult>("checker", () => {
      checkCount++;
      if (checkCount === 1) return { pass: false, errors: ["syntax error"] };
      return { pass: true, errors: [] };
    });
    const fixer = mockAgent<{ code: string; errors: string[] }, string>(
      "fixer",
      () => {
        fixCount++;
        return "fixed code";
      }
    );

    const proc = codeThenFix({
      coder,
      checker,
      fixer,
      task: "buggy task",
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("ctf-fix", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value, "fixed code");
    }
    assert.equal(checkCount, 2);
    assert.equal(fixCount, 1);
  });
});

describe("fanOut", () => {
  it("runs agents in parallel and merges results", async () => {
    const agents = [
      mockAgent<string, string>("model-a", (q) => `A: ${q}`),
      mockAgent<string, string>("model-b", (q) => `B: ${q}`),
      mockAgent<string, string>("model-c", (q) => `C: ${q}`),
    ];

    const proc = fanOut({
      agents,
      input: "question",
      merge: (results) => results.sort(),
    });

    const scheduler = makeScheduler();
    const result = await scheduler.run("fanout-test", proc);

    assert.ok(result.success);
    if (result.success) {
      assert.deepEqual(result.value, [
        "A: question",
        "B: question",
        "C: question",
      ]);
    }
  });
});

describe("handoff", () => {
  it("transfers data between two agents via a channel", async () => {
    let receivedByTo = "";

    const from = mockAgent<void, string>("producer", () => "handoff-data");
    const to: AgentCall<string, void> = {
      name: "consumer",
      invoke: async (input: string) => {
        receivedByTo = input;
      },
    };

    const proc = handoff({ from, to });

    const scheduler = makeScheduler();
    const result = await scheduler.run("handoff-test", proc);

    assert.ok(result.success);
    assert.equal(receivedByTo, "handoff-data");
  });
});
